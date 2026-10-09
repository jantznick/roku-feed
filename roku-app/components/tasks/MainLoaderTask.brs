' ********** Copyright 2020 Roku Corp.  All Rights Reserved. **********

' Note that we need to import this file in MainLoaderTask.xml using relative path.
sub Init()
    ' set the name of the function in the Task node component to be executed when the state field changes to RUN
    ' in our case this method executed after the following cmd: m.contentTask.control = "run"(see Init method in MainScene)
    m.top.functionName = "GetContent"
end sub

' Load each feed source independently. Publish cached rows immediately, then refresh.
' A single hung/failed source (Plex, account sync, etc.) must not lock out the rest.
sub GetContent()
    m.top.status = "loading"
    m.top.message = ""

    ' 1) Instant UI from last good merge (stale-while-revalidate)
    cachedMerged = LoadMergedFeedCache()
    publishedFromCache = false
    if cachedMerged <> invalid
        contentNode = BuildContentNodeFromFeed(cachedMerged)
        if contentNode <> invalid and contentNode.GetChildCount() > 0
            m.top.content = contentNode
            m.top.status = "cached"
            m.top.message = "Showing saved library while refreshing…"
            publishedFromCache = true
        end if
    end if

    ' 2) Account sync is best-effort and short — never gate the whole channel on it
    SyncFeedFromAccount(5000)

    ' Prefer caller-provided URL as a single-source override (settings reload path)
    sources = []
    overrideUrl = m.top.feedUrl
    if overrideUrl <> invalid and overrideUrl <> "" and IsValidFeedUrl(overrideUrl)
        sources.Push({
            id: "live",
            label: "Live",
            url: overrideUrl,
            timeoutMs: 20000
        })
    else
        sources = GetFeedSources()
    end if

    merged = {
        providerName: "We Like Sports",
        lastUpdated: invalid,
        rows: []
    }
    ' rows held as { title, children:[] } for stable merge order
    rowIndexByTitle = {}
    successCount = 0
    failCount = 0
    usedStaleSource = false

    for each source in sources
        result = LoadOneSource(source)
        if result = invalid or result.json = invalid
            failCount = failCount + 1
        else
            if result.stale = true
                usedStaleSource = true
            else
                successCount = successCount + 1
            end if
            AppendFeedJsonToRows(merged, rowIndexByTitle, result.json, source)
            ' Progressive publish: usable as soon as any source returns
            contentNode = BuildContentNodeFromMerged(merged)
            if contentNode <> invalid and contentNode.GetChildCount() > 0
                m.top.content = contentNode
                if successCount > 0 and failCount = 0 and not usedStaleSource
                    m.top.status = "loading"
                else
                    m.top.status = "partial"
                end if
            end if
        end if
    end for

    contentNode = BuildContentNodeFromMerged(merged)
    hasRows = contentNode <> invalid and contentNode.GetChildCount() > 0

    if hasRows
        m.top.content = contentNode
        SaveMergedFeedCache(MergedToCacheJson(merged))
        if failCount > 0 or usedStaleSource
            m.top.status = "partial"
            m.top.message = "Some libraries failed to load. Others are ready."
        else
            m.top.status = "ready"
            m.top.message = ""
        end if
    else if publishedFromCache
        m.top.status = "stale"
        m.top.message = "Using saved library. Pull failed — press * to retry."
    else
        ' Empty grid + clear status so the spinner never traps the user
        empty = CreateObject("roSGNode", "ContentNode")
        m.top.content = empty
        m.top.status = "error"
        m.top.message = "Couldn't load libraries. Press * for settings / retry."
    end if
end sub

function LoadOneSource(source as Object) as Object
    timeoutMs = 20000
    if source.timeoutMs <> invalid
        timeoutMs = source.timeoutMs
    end if

    body = HttpGetWithTimeout(source.url, timeoutMs)
    json = ParseJsonResponse(body)
    if json <> invalid
        SaveFeedCache(source.id, body)
        return { json: json, stale: false }
    end if

    ' Fall back to per-source cache so one bad refresh does not drop that library
    cached = LoadFeedCache(source.id)
    if cached <> invalid
        return { json: cached, stale: true }
    end if
    return invalid
end function

sub AppendFeedJsonToRows(merged as Object, rowIndexByTitle as Object, json as Object, source as Object)
    if json = invalid
        return
    end if
    if json.lastUpdated <> invalid
        merged.lastUpdated = json.lastUpdated
    end if
    if json.providerName <> invalid and json.providerName <> ""
        merged.providerName = json.providerName
    end if

    for each category in json
        value = json.Lookup(category)
        if Type(value) = "roArray" and category <> "series"
            title = category
            ' Optional per-source prefix avoids colliding row names across libraries
            if source <> invalid and source.rowPrefix <> invalid and source.rowPrefix <> ""
                title = source.rowPrefix + category
            else if source <> invalid and source.label <> invalid and source.label <> "" and source.id <> "live" and category = "content"
                title = source.label
            end if

            children = []
            for each item in value
                itemData = GetItemData(item, merged.lastUpdated)
                if itemData <> invalid
                    children.Push(itemData)
                end if
            end for

            if children.Count() > 0
                existingIndex = rowIndexByTitle.Lookup(title)
                if existingIndex <> invalid
                    row = merged.rows[existingIndex]
                    for each child in children
                        row.children.Push(child)
                    end for
                else
                    rowIndexByTitle.AddReplace(title, merged.rows.Count())
                    merged.rows.Push({
                        title: title,
                        children: children
                    })
                end if
            end if
        end if
    end for
end sub

function MergedToCacheJson(merged as Object) as Object
    out = {
        providerName: merged.providerName,
        lastUpdated: merged.lastUpdated
    }
    if merged.rows <> invalid
        for each row in merged.rows
            ' Cache in feed shape: category -> array of original-ish item maps
            ' We stored display maps; rebuild minimal feed items from them for cache reuse
            items = []
            for each child in row.children
                items.Push(DisplayItemToCacheItem(child))
            end for
            out.AddReplace(row.title, items)
        end for
    end if
    return out
end function

function DisplayItemToCacheItem(item as Object) as Object
    video = {
        id: item.id,
        title: item.title,
        thumbnail: item.hdPosterURL,
        releaseDate: item.releaseDate,
        longDescription: item.description,
        shortDescription: item.description
    }
    if item.streamContent <> invalid
        video.content = item.streamContent
    else if item.url <> invalid and item.url <> ""
        video.content = {
            duration: item.length,
            videos: [{
                url: item.url,
                videoType: item.streamFormat,
                quality: "default"
            }]
        }
    end if
    return video
end function

function BuildContentNodeFromFeed(json as Object) as Object
    merged = {
        providerName: "We Like Sports",
        lastUpdated: invalid,
        rows: []
    }
    rowIndexByTitle = {}
    AppendFeedJsonToRows(merged, rowIndexByTitle, json, { id: "live", label: "Live" })
    return BuildContentNodeFromMerged(merged)
end function

function BuildContentNodeFromMerged(merged as Object) as Object
    rootChildren = []
    if merged <> invalid and merged.rows <> invalid
        for each row in merged.rows
            if row.children <> invalid and row.children.Count() > 0
                rootChildren.Push(row)
            end if
        end for
    end if
    contentNode = CreateObject("roSGNode", "ContentNode")
    fields = { children: rootChildren }
    if merged <> invalid and merged.lastUpdated <> invalid
        fields.lastUpdated = merged.lastUpdated
    end if
    contentNode.Update(fields, true)
    return contentNode
end function

function GetItemData(video as Object, lastUpdated as Dynamic) as Object
    if video = invalid
        return invalid
    end if

    item = {}
    lastUpdatedStr = ""
    localTimeStr = ""
    descriptionStr = ""
    leaguePart = ""
    dashPosition = 0
    dt = invalid

    ' populate some standard content metadata fields to be displayed on the GridScreen
    ' https://developer.roku.com/docs/developer-program/getting-started/architecture/content-metadata.md
    if video.longDescription <> invalid
        item.description = video.longDescription
    else
        ' Construct the description and append the last updated time.
        if lastUpdated <> invalid
            dt = CreateObject("roDateTime")
            dt.FromISO8601String(lastUpdated)
            dt.ToLocalTime()
            ' Format to something like "11/12/2025 09:30 PM"
            lastUpdatedStr = dt.AsDateString("short-month-short-day-year") + " " + Get12HourTime(dt)
        end if

        descriptionStr = video.shortDescription
        if descriptionStr = invalid
            descriptionStr = ""
        end if
        dashPosition = descriptionStr.Instr(0, " - ")
        leaguePart = descriptionStr
        if dashPosition > 0
            leaguePart = descriptionStr.Left(dashPosition)
        end if

        if video.content <> invalid and video.content.dateAdded <> invalid
            dt = CreateObject("roDateTime")
            dt.FromISO8601String(video.content.dateAdded)
            dt.ToLocalTime()
            localTimeStr = Get12HourTime(dt)
        end if

        item.description = leaguePart
        if localTimeStr <> ""
            item.description = item.description + " - Start Time: " + localTimeStr
        end if

        if lastUpdatedStr <> ""
            item.description = item.description + chr(10) + "Feed Last Updated: " + lastUpdatedStr
        end if
    end if
    item.hdPosterURL = video.thumbnail
    item.title = video.title
    if item.title = invalid or item.title = ""
        item.title = "Untitled"
    end if
    item.releaseDate = video.releaseDate
    item.id = video.id
    if video.content <> invalid
        ' populate length of content to be displayed on the GridScreen
        item.length = video.content.duration

        ' populate meta-data for playback — skip broken items instead of killing the row
        videos = video.content.videos
        if Type(videos) = "roArray" and videos.Count() > 0 and videos[0] <> invalid and videos[0].url <> invalid
            item.url = videos[0].url
            item.streamFormat = videos[0].videoType
            item.streamContent = video.content
        else
            ' Keep the poster in the grid but mark unplayable; details can still show info
            item.streamContent = video.content
        end if
    end if
    return item
end function
