' Settings screen helpers for MainScene.

sub ShowSettingsScreen()
    ' Avoid stacking multiple settings screens
    current = GetCurrentScreen()
    if current <> invalid and current.subtype() = "SettingsScreen"
        return
    end if

    settings = CreateObject("roSGNode", "SettingsScreen")
    settings.ObserveField("feedChanged", "OnFeedSettingsChanged")
    ShowScreen(settings)
end sub

sub OnFeedSettingsChanged(event as Object)
    action = event.GetData()
    if action = invalid or action = ""
        return
    end if

    ' Close settings and reload feed content with the active URL
    CloseScreen(invalid)
    RunContentTask()
end sub
