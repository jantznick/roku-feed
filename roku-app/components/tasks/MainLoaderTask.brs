' ********** Copyright 2020 Roku Corp.  All Rights Reserved. **********

' Note that we need to import this file in MainLoaderTask.xml using relative path.
sub Init()
    ' set the name of the function in the Task node component to be executed when the state field changes to RUN
    ' in our case this method executed after the following cmd: m.contentTask.control = "run"(see Init method in MainScene)
    m.top.functionName = "GetContent"
end sub

sub GetContent()
    ' Best-effort account sync — must not hang the channel forever
    SyncFeedFromAccount()

    feedUrl = m.top.feedUrl
    if feedUrl = invalid or feedUrl = ""
        feedUrl = GetFeedUrl()
    end if

    rsp = FetchFeedString(feedUrl, 20000)
    rootChildren = []
    lastUpdated = invalid

    ' parse the feed and build a tree of ContentNodes to populate the GridView
    json = ParseJson(rsp)
    if json <> invalid
        if json.lastUpdated <> invalid
            lastUpdated = json.lastUpdated
        end if

        for each category in json
            value = json.Lookup(category)
            if Type(value) = "roArray" ' if parsed key value having other objects in it
                if category <> "series" ' ignore series for this phase
                    row = {}
                    row.title = category
                    row.children = []
                    for each item in value ' parse items and push them to row
                        itemData = GetItemData(item, lastUpdated)
                        if itemData <> invalid
                            row.children.Push(itemData)
                        end if
                    end for
                    if row.children.Count() > 0
                        rootChildren.Push(row)
                    end if
                end if
            end if
        end for
    end if

    ' Always publish content (even empty) so Loading… never traps the user
    contentNode = CreateObject("roSGNode", "ContentNode")
    contentNode.Update({
        children: rootChildren,
        lastUpdated: lastUpdated
    }, true)
    m.top.content = contentNode
end sub

' Timed GET so a dead host cannot leave the spinner up forever.
function FetchFeedString(url as String, timeoutMs as Integer) as String
    if url = invalid or url = ""
        return ""
    end if
    xfer = CreateObject("roURLTransfer")
    xfer.SetCertificatesFile("common:/certs/ca-bundle.crt")
    xfer.InitClientCertificates()
    xfer.SetURL(url)
    port = CreateObject("roMessagePort")
    xfer.SetMessagePort(port)
    if not xfer.AsyncGetToString()
        return ""
    end if
    msg = wait(timeoutMs, port)
    if msg = invalid or type(msg) <> "roUrlEvent"
        xfer.AsyncCancel()
        return ""
    end if
    if msg.GetResponseCode() < 200 or msg.GetResponseCode() >= 300
        return ""
    end if
    body = msg.GetString()
    if body = invalid
        return ""
    end if
    return body
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
    item.releaseDate = video.releaseDate
    item.id = video.id
    if video.content <> invalid
        ' populate length of content to be displayed on the GridScreen
        item.length = video.content.duration

        ' populate meta-data for playback — skip broken items instead of aborting the feed
        videos = video.content.videos
        if Type(videos) = "roArray" and videos.Count() > 0 and videos[0] <> invalid and videos[0].url <> invalid
            item.url = videos[0].url
            item.streamFormat = videos[0].videoType
            item.streamContent = video.content
        else
            return invalid
        end if
    end if
    return item
end function
