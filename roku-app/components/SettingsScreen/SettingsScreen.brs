sub Init()
    m.menu = m.top.FindNode("menu")
    m.currentUrlLabel = m.top.FindNode("currentUrlLabel")
    m.pairCodeLabel = m.top.FindNode("pairCodeLabel")
    m.hintLabel = m.top.FindNode("hintLabel")
    m.top.ObserveField("visible", "OnVisibleChange")
    m.menu.ObserveField("itemSelected", "OnMenuItemSelected")
    m.pairing = false
    RefreshDisplay()
end sub

sub OnVisibleChange()
    if m.top.visible = true
        RefreshDisplay()
        m.menu.SetFocus(true)
    end if
end sub

sub RefreshDisplay()
    lines = []

    if IsAccountLinked()
        email = GetLinkedEmail()
        if email <> ""
            lines.Push("Linked account: " + email)
        else
            lines.Push("Linked account: yes")
        end if
        synced = GetSyncedFeedUrl()
        if synced <> ""
            lines.Push("Synced feed:" + chr(10) + synced)
        else
            lines.Push("Synced feed: (will refresh on reload)")
        end if
    else
        lines.Push("Account: not linked")
        customUrl = GetCustomFeedUrl()
        if customUrl <> ""
            lines.Push("Local override:" + chr(10) + customUrl)
        else
            lines.Push("Using default feed:" + chr(10) + GetDefaultFeedUrl())
        end if
    end if

    text = ""
    for each line in lines
        if text = ""
            text = line
        else
            text = text + chr(10) + line
        end if
    end for
    m.currentUrlLabel.text = text

    items = []
    if IsAccountLinked()
        items.Push({ title: "Unlink Account" })
        items.Push({ title: "Sync Feed Now" })
    else
        items.Push({ title: "Link Web Account" })
    end if
    items.Push({ title: "Set Local Feed URL Override" })
    items.Push({ title: "Clear Local Override" })
    items.Push({ title: "Reload Feed" })

    content = CreateObject("roSGNode", "ContentNode")
    for each item in items
        node = CreateObject("roSGNode", "ContentNode")
        node.title = item.title
        content.AppendChild(node)
    end for
    m.menu.content = content
    m.menuItems = items
end sub

sub OnMenuItemSelected()
    if m.pairing = true
        return
    end if
    index = m.menu.itemSelected
    if index < 0 or m.menuItems = invalid or index >= m.menuItems.Count()
        return
    end if
    title = m.menuItems[index].title

    if title = "Link Web Account"
        StartAccountLink()
    else if title = "Unlink Account"
        ClearDeviceLink()
        m.pairCodeLabel.visible = false
        RefreshDisplay()
        m.top.feedChanged = "unlinked"
    else if title = "Sync Feed Now"
        if SyncFeedFromAccount()
            RefreshDisplay()
            m.top.feedChanged = "synced"
        else
            m.hintLabel.text = "Sync failed. Check network and link status."
        end if
    else if title = "Set Local Feed URL Override"
        ShowFeedUrlKeyboard()
    else if title = "Clear Local Override"
        ClearFeedUrl()
        RefreshDisplay()
    else if title = "Reload Feed"
        m.top.feedChanged = "reload"
    end if
end sub

sub StartAccountLink()
    m.pairing = true
    m.hintLabel.text = "Starting pairing…"
    m.pairCodeLabel.visible = true
    m.pairCodeLabel.text = "…"

    task = CreateObject("roSGNode", "DevicePairTask")
    task.ObserveField("status", "OnPairStatus")
    task.ObserveField("code", "OnPairCode")
    m.pairTask = task
    task.control = "RUN"
end sub

sub OnPairCode()
    if m.pairTask = invalid
        return
    end if
    code = m.pairTask.code
    if code <> invalid and code <> ""
        m.pairCodeLabel.text = "Code: " + code
        m.hintLabel.text = "On the web settings page, enter this code while signed in."
    end if
end sub

sub OnPairStatus()
    if m.pairTask = invalid
        return
    end if
    status = m.pairTask.status
    if status = "pending" or status = "starting"
        return
    end if

    m.pairing = false
    msg = m.pairTask.message
    if msg = invalid
        msg = status
    end if
    m.hintLabel.text = msg

    if status = "linked"
        m.pairCodeLabel.visible = false
        RefreshDisplay()
        m.top.feedChanged = "linked"
    else
        RefreshDisplay()
    end if
    m.pairTask = invalid
end sub

sub ShowFeedUrlKeyboard()
    dialog = CreateObject("roSGNode", "KeyboardDialog")
    dialog.title = "Local Feed URL Override"
    dialog.text = GetFeedUrl()
    dialog.buttons = ["Save", "Cancel"]
    dialog.ObserveField("buttonSelected", "OnFeedKeyboardButtonSelected")
    m.keyboardDialog = dialog
    scene = m.top.GetScene()
    if scene <> invalid
        scene.dialog = dialog
    end if
end sub

sub OnFeedKeyboardButtonSelected()
    if m.keyboardDialog = invalid
        return
    end if
    buttonIndex = m.keyboardDialog.buttonSelected
    if buttonIndex = 0
        url = m.keyboardDialog.text
        if IsValidFeedUrl(url)
            SetFeedUrl(url)
            CloseKeyboardDialog()
            RefreshDisplay()
            m.top.feedChanged = "saved"
        else
            m.keyboardDialog.title = "URL must start with http:// or https://"
        end if
    else
        CloseKeyboardDialog()
    end if
end sub

sub CloseKeyboardDialog()
    scene = m.top.GetScene()
    if scene <> invalid
        scene.dialog = invalid
    end if
    m.keyboardDialog = invalid
end sub
