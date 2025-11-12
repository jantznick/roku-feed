' ********** Copyright 2020 Roku Corp.  All Rights Reserved. **********

 ' entry point of detailsScreen
function Init()
    ' observe "visible" so we can know when DetailsScreen change visibility
    m.top.ObserveField("visible", "OnVisibleChange")
    ' observe "itemFocused" so we can know when another item gets in focus
    m.top.ObserveField("itemFocused", "OnItemFocusedChanged")
    ' save a references to the DetailsScreen child components in the m variable
    ' so we can access them easily from other functions
    m.buttons = m.top.FindNode("buttons")
    m.poster = m.top.FindNode("poster") 
    m.description = m.top.FindNode("descriptionLabel")
    m.timeLabel = m.top.FindNode("timeLabel")
    m.titleLabel = m.top.FindNode("titleLabel")
    m.releaseLabel = m.top.FindNode("releaseLabel")
    
    ' Observe the focused item on the button list to dynamically update the description
    m.buttons.ObserveField("itemFocused", "OnStreamButtonFocused")
end function

sub OnVisibleChange() ' invoked when DetailsScreen visibility is changed
    if m.top.visible = true
        m.buttons.SetFocus(true)
    end if
end sub

' This is a new observer that fires when the user highlights a different stream button
sub OnStreamButtonFocused()
    ' Get the data for the currently highlighted button
    focusedButtonIndex = m.buttons.itemFocused
    if focusedButtonIndex < 0 or focusedButtonIndex >= m.buttons.content.getChildCount()
        return
    end if
    
    buttonData = m.buttons.content.getChild(focusedButtonIndex)

    baseDescription = m.top.basetext
    if baseDescription = invalid
        baseDescription = ""
    end if

    ' Format the confirmedAt timestamp for display.
    confirmedTimeStr = ""
    if buttonData.confirmedAt <> invalid
        dt = CreateObject("roDateTime")
        dt.FromISO8601String(buttonData.confirmedAt)
        dt.ToLocalTime()
        ' Get HH:MM:SS AM/PM
        confirmedTimeStr = Get12HourTimeWithSeconds(dt)
    end if

    newDescription = baseDescription
    if confirmedTimeStr <> ""
        ' Add a couple of newlines to separate it from the main description
        newDescription = newDescription + chr(10) + chr(10) + "Stream Confirmed: " + confirmedTimeStr
    end if
    
    m.description.text = newDescription
end sub

' Populate content details information
sub SetDetailsContent(content as Object)
    ' Store the original description in a custom field so we can reuse it
    m.description.text = content.description
    m.description.color = "#ffffff"
    m.top.basetext = content.description
    
    m.poster.uri = content.hdPosterUrl ' set url of content poster
    
    ' Check if the game is live and update the time label accordingly
    if content.streamContent <> invalid and content.streamContent.dateAdded <> invalid
        startTime = CreateObject("roDateTime")
        startTime.FromISO8601String(content.streamContent.dateAdded)
        startTimeSeconds = startTime.AsSeconds()
        
        now = CreateObject("roDateTime")
        now.Mark()
        nowSeconds = now.AsSeconds()
        
        durationSeconds = content.length
        
        if nowSeconds > startTimeSeconds and nowSeconds < (startTimeSeconds + durationSeconds)
            m.timeLabel.text = "LIVE"
        else
            m.timeLabel.text = "Duration: " + GetTime(content.length)
        end if
    else
        m.timeLabel.text = "Duration: " + GetTime(content.length)
    end if

    m.titleLabel.text = content.title ' set title of content
    
    ' Display the start time in the user's local timezone
    if content.streamContent <> invalid and content.streamContent.dateAdded <> invalid
        dt = CreateObject("roDateTime")
        dt.FromISO8601String(content.streamContent.dateAdded)
        dt.ToLocalTime()
        timeStr = Get12HourTime(dt)
        m.releaseLabel.text = "Start Time: " + dt.AsDateString("long-date") + " at " + timeStr
    else
        m.releaseLabel.text = content.releaseDate ' set release date of content
    end if

    ' Create buttons for each video stream
    result = []
    if content.streamContent <> invalid and content.streamContent.videos <> invalid
        for each video in content.streamContent.videos
            ' Pass the full video object to the node, not just the title
            video.title = video.quality
            result.Push(video)
        end for
    else
        ' Fallback to a single play button if no streams are found
        result.Push({title : "Play"})
    end if
    m.buttons.content = ContentListToNode(result) ' set list of buttons for DetailsScreen
end sub

sub OnJumpToItem() ' invoked when jumpToItem field is populated
    content = m.top.content
    ' check if jumpToItem field has valid value
    ' it should be set within interval from 0 to content.Getchildcount()
    if content <> invalid and m.top.jumpToItem >= 0 and content.GetChildCount() > m.top.jumpToItem
        ' This is now the single, reliable place where itemFocused is set.
        m.top.itemFocused = m.top.jumpToItem
    end if
end sub

sub OnItemFocusedChanged(event as Object)' invoked when another item is focused
    focusedItem = event.GetData() ' get position of focused item
    content = m.top.content.GetChild(focusedItem) ' get metadata of focused item
    SetDetailsContent(content) ' populate DetailsScreen with item metadata
end sub

' The OnKeyEvent() function receives remote control key events
function OnkeyEvent(key as String, press as Boolean) as Boolean
    result = false
    if press
        if key = "up" or key = "down"
            ' let the LabelList handle up/down navigation
            return false
        end if

        currentItem = m.top.itemFocused ' position of currently focused item
        ' handle "left" button keypress
        if key = "left"
            ' navigate to the left item in case of "left" keypress
            m.top.jumpToItem = currentItem - 1 
            result = true
        ' handle "right" button keypress
        else if key = "right" 
            ' navigate to the right item in case of "right" keypress
            m.top.jumpToItem = currentItem + 1 
            result = true
        end if
    end if
    return result
end function

' Helper function to get a formatted 12-hour time string with seconds
function Get12HourTimeWithSeconds(dt as Object) as String
    hour = dt.GetHours()
    minutes = dt.GetMinutes()
    seconds = dt.GetSeconds()
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
    ' Use a manual, safe padding function and trim the leading space from Str()
    return Str(hour).Trim() + ":" + PadLeft(minutes) + ":" + PadLeft(seconds) + " " + ampm
end function

' Safely pads a number to 2 digits with a leading zero for string formatting.
' This avoids issues with object methods on primitive types.
function PadLeft(num as Integer) as String
    ' Trim the leading space that Str() adds to non-negative numbers
    numStr = Str(num).Trim()
    if num < 10
        return "0" + numStr
    else
        return numStr
    end if
end function

' Helper function to convert a list of objects to a ContentNode
function ContentListToNode(contentList as Object) as Object
    node = CreateObject("roSGNode", "ContentNode")
    for each item in contentList
        itemNode = CreateObject("roSGNode", "ContentNode")
        itemNode.Update(item, true)
        node.appendChild(itemNode)
    end for
    return node
end function