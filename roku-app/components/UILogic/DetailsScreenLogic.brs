' ********** Copyright 2020 Roku Corp.  All Rights Reserved. **********

' Note that we need to import this file in MainScene.xml using relative path.

sub ShowDetailsScreen(content as Object, selectedItem as Integer)
    ' create new instance of details screen
    detailsScreen = CreateObject("roSGNode", "DetailsScreen")
    detailsScreen.content = content
    detailsScreen.jumpToItem = selectedItem ' set index of item which should be focused
    detailsScreen.ObserveField("visible", "OnDetailsScreenVisibilityChanged")
    detailsScreen.ObserveField("buttonSelected", "OnButtonSelected")
    ShowScreen(detailsScreen)
end sub

sub OnButtonSelected(event) ' invoked when button in DetailsScreen is pressed
    details = event.GetRoSGNode()
    content = details.content
    buttonIndex = event.getData() ' index of selected button
    selectedItem = details.itemFocused
    
    ' Store the currently focused item index on the global node.
    ' This ensures that we can return to the correct item if video playback fails.
    m.global.SetField("lastFocusedItem", selectedItem, true)

    ' get the specific item that is in focus
    itemNode = content.getChild(selectedItem)
    
    ' get the list of available videos
    if itemNode <> invalid and itemNode.streamContent <> invalid and itemNode.streamContent.videos <> invalid
        videos = itemNode.streamContent.videos
        if buttonIndex >= 0 and buttonIndex < videos.count()
            ' get the selected video
            selectedVideo = videos[buttonIndex]
            print "Selected video: "; selectedVideo
            
            ' we need to clone the item node because it will be damaged in case of video node content invalidation
            clonedItemNode = itemNode.clone(true)
            ' update the url on the cloned node
            clonedItemNode.url = selectedVideo.url
            
            ' create a new content node to hold our single, cloned item
            newContent = createObject("roSGNode", "ContentNode")
            newContent.appendChild(clonedItemNode)

            ' now call ShowVideoScreen with our new content that has the correct url
            ' we pass 0 as the selectedItem because it's the first (and only) item
            ShowVideoScreen(newContent, 0)
        end if
    else
        ' Fallback to original behavior if streamContent is not available
        if buttonIndex = 0 ' check if "Play" button is pressed
            ' create Video node and start playback
            ShowVideoScreen(content, selectedItem)
        end if
    end if
end sub

sub OnDetailsScreenVisibilityChanged(event as Object) ' invoked when DetailsScreen "visible" field is changed
    visible = event.GetData()
    detailsScreen = event.GetRoSGNode()

    ' If the screen is becoming visible again (e.g., after a video player closes)
    if visible = true and m.global.lastFocusedItem <> invalid
        ' Restore the focus to the item that was selected before playback.
        detailsScreen.jumpToItem = m.global.lastFocusedItem
        ' Clear the field so it doesn't interfere with normal navigation.
        m.global.RemoveField("lastFocusedItem")
    end if

    ' update GridScreen's focus when navigate back from DetailsScreen
    if visible = false
        m.GridScreen.jumpToRowItem = [m.selectedIndex[0], detailsScreen.itemFocused]
    end if
end sub