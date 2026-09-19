sub Init()
    m.menu = m.top.FindNode("menu")
    m.currentUrlLabel = m.top.FindNode("currentUrlLabel")
    m.top.ObserveField("visible", "OnVisibleChange")
    m.menu.ObserveField("itemSelected", "OnMenuItemSelected")
    RefreshDisplay()
end sub

sub OnVisibleChange()
    if m.top.visible = true
        RefreshDisplay()
        m.menu.SetFocus(true)
    end if
end sub

sub RefreshDisplay()
    feedUrl = GetFeedUrl()
    customUrl = GetCustomFeedUrl()
    if customUrl <> ""
        m.currentUrlLabel.text = "Using custom feed:" + chr(10) + feedUrl
    else
        m.currentUrlLabel.text = "Using default feed:" + chr(10) + feedUrl
    end if

    items = []
    items.Push({ title: "Set Custom Feed URL" })
    items.Push({ title: "Use Default Feed" })
    items.Push({ title: "Reload Feed" })

    content = CreateObject("roSGNode", "ContentNode")
    for each item in items
        node = CreateObject("roSGNode", "ContentNode")
        node.title = item.title
        content.AppendChild(node)
    end for
    m.menu.content = content
end sub

sub OnMenuItemSelected()
    index = m.menu.itemSelected
    if index = 0
        ShowFeedUrlKeyboard()
    else if index = 1
        ClearFeedUrl()
        RefreshDisplay()
        m.top.feedChanged = "cleared"
    else if index = 2
        m.top.feedChanged = "reload"
    end if
end sub

sub ShowFeedUrlKeyboard()
    dialog = CreateObject("roSGNode", "KeyboardDialog")
    dialog.title = "Enter Feed URL"
    dialog.text = GetFeedUrl()
    dialog.buttons = ["Save", "Cancel"]
    dialog.ObserveField("buttonSelected", "OnKeyboardButtonSelected")
    m.keyboardDialog = dialog
    scene = m.top.GetScene()
    if scene <> invalid
        scene.dialog = dialog
    end if
end sub

sub OnKeyboardButtonSelected()
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
            ' Keep dialog open; briefly show validation hint in the title.
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
