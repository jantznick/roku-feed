' ********** Copyright 2020 Roku Corp.  All Rights Reserved. **********

' Note that we need to import this file in MainLoaderTask.xml using relative path.
sub Init()
    ' set the name of the function in the Task node component to be executed when the state field changes to RUN
    ' in our case this method executed after the following cmd: m.contentTask.control = "run"(see Init method in MainScene)
    m.top.functionName = "GetContent"
end sub

sub GetContent()
    ' request the content feed from the API
    xfer = CreateObject("roURLTransfer")
    xfer.SetCertificatesFile("common:/certs/ca-bundle.crt")
    ' xfer.SetURL("https://jonathanbduval.com/roku/feeds/roku-developers-feed-v1.json")
    xfer.SetURL("https://f004.backblazeb2.com/file/roku-hockey/secretfeedfilename.json")
    rsp = xfer.GetToString()
    rootChildren = []
    rows = {}

    ' parse the feed and build a tree of ContentNodes to populate the GridView
    json = ParseJson(rsp)
    if json <> invalid
        for each category in json
            value = json.Lookup(category)
            if Type(value) = "roArray" ' if parsed key value having other objects in it
                if category <> "series" ' ignore series for this phase
                    row = {}
                    row.title = category
                    row.children = []
                    for each item in value ' parse items and push them to row
                        itemData = GetItemData(item)
                        row.children.Push(itemData)
                    end for
                    rootChildren.Push(row)
                end if
            end if
        end for
        ' set up a root ContentNode to represent rowList on the GridScreen
        contentNode = CreateObject("roSGNode", "ContentNode")
        contentNode.Update({
            children: rootChildren
        }, true)
        ' populate content field with root content node.
        ' Observer(see OnMainContentLoaded in MainScene.brs) is invoked at that moment
        m.top.content = contentNode
        
        ' After successfully parsing, store the lastUpdated timestamp on the global node
        if json.lastUpdated <> invalid
            m.global.SetField("lastUpdated", json.lastUpdated, true)
        end if
    end if
end sub

function GetItemData(video as Object) as Object
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
        if m.global.lastUpdated <> invalid
            dt = CreateObject("roDateTime")
            dt.FromISO8601String(m.global.lastUpdated)
            dt.ToLocalTime()
            ' Format to something like "11/12/2025 09:30 PM"
            lastUpdatedStr = dt.AsDateString("short-month-short-day-year") + " " + Get12HourTime(dt)
        end if

        descriptionStr = video.shortDescription
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
        
        ' populate meta-data for playback
        ' For the default play button, we'll still use the first stream
        item.url = video.content.videos[0].url
        item.streamFormat = video.content.videos[0].videoType
        
        ' Pass the entire content object to be used by the details screen
        item.streamContent = video.content
    end if
    return item
end function

function Get12HourTime(dt as Object) as String
    hour = dt.GetHours()
    minutes = dt.GetMinutes()
    ampm = "AM"
    if hour >= 12
        ampm = "PM"
    end if
    if hour > 12
        hour = hour - 12
    end if
    if hour = 0
        hour = 12
    end if
    return hour.ToStr() + ":" + minutes.ToPaddedString(2, "0") + " " + ampm
end function
