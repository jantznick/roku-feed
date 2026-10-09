' ********** Copyright 2020 Roku Corp.  All Rights Reserved. **********

' Note that we need to import this file in MainScene.xml using relative path.

sub RunContentTask()
    m.contentTask = CreateObject("roSGNode", "MainLoaderTask")
    ' Leave feedUrl empty so the task loads every configured source independently.
    ' A single hung source must not block Live TV, sports, Plex, etc.
    m.contentTask.feedUrl = ""
    m.contentTask.ObserveField("content", "OnMainContentLoaded")
    m.contentTask.ObserveField("status", "OnContentTaskStatus")
    m.contentTask.ObserveField("message", "OnContentTaskMessage")
    m.contentTask.control = "run"
    if m.loadingIndicator <> invalid
        m.loadingIndicator.text = "Loading…"
        ' Only block the UI when we have nothing to show yet
        if m.GridScreen = invalid or m.GridScreen.content = invalid or m.GridScreen.content.GetChildCount() = 0
            m.loadingIndicator.visible = true
        else
            m.loadingIndicator.visible = false
        end if
    end if
end sub

sub OnMainContentLoaded() ' invoked whenever a source (or cache) publishes rows
    if m.contentTask = invalid
        return
    end if
    content = m.contentTask.content
    if content = invalid
        return
    end if

    m.GridScreen.content = content
    if content.GetChildCount() > 0
        m.GridScreen.SetFocus(true)
        if m.loadingIndicator <> invalid
            m.loadingIndicator.visible = false
        end if
    end if
end sub

sub OnContentTaskStatus()
    if m.contentTask = invalid or m.loadingIndicator = invalid
        return
    end if

    status = m.contentTask.status
    if status = invalid
        return
    end if

    if status = "cached" or status = "partial" or status = "ready" or status = "stale"
        m.loadingIndicator.visible = false
        if m.GridScreen <> invalid
            m.GridScreen.SetFocus(true)
        end if
    else if status = "error"
        ' Unlock the UI even when every source failed
        m.loadingIndicator.visible = true
        msg = m.contentTask.message
        if msg = invalid or msg = ""
            msg = "Couldn't load libraries. Press * for settings / retry."
        end if
        m.loadingIndicator.text = msg
        if m.GridScreen <> invalid
            m.GridScreen.SetFocus(true)
        end if
    else if status = "loading"
        if m.GridScreen = invalid or m.GridScreen.content = invalid or m.GridScreen.content.GetChildCount() = 0
            m.loadingIndicator.visible = true
            m.loadingIndicator.text = "Loading…"
        end if
    end if
end sub

sub OnContentTaskMessage()
    if m.contentTask = invalid or m.loadingIndicator = invalid
        return
    end if
    status = m.contentTask.status
    msg = m.contentTask.message
    if status = "error" and msg <> invalid and msg <> ""
        m.loadingIndicator.text = msg
        m.loadingIndicator.visible = true
    end if
end sub
