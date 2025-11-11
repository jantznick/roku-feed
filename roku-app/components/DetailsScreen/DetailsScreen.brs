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
end function

sub OnVisibleChange() ' invoked when DetailsScreen visibility is changed
    ' set focus for buttons list when DetailsScreen become visible
    if m.top.visible = true
        m.buttons.SetFocus(true)
        m.top.itemFocused = m.top.jumpToItem
    end if
end sub

' Populate content details information
sub SetDetailsContent(content as Object)
    m.description.text = content.description
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
            result.Push({title : video.quality})
        end for
    else
        ' Fallback to a single play button if no streams are found
        result.Push({title : "Play"})
    end if
    m.buttons.content = ContentListToSimpleNode(result) ' set list of buttons for DetailsScreen
end sub

sub OnJumpToItem() ' invoked when jumpToItem field is populated
    content = m.top.content
    ' check if jumpToItem field has valid value
    ' it should be set within interval from 0 to content.Getchildcount()
    if content <> invalid and m.top.jumpToItem >= 0 and content.GetChildCount() > m.top.jumpToItem
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