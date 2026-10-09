' Feed URL + account sync helpers.
' Registry section "feed":
'   feedUrl          — optional local override (sideload/testing)
'   syncedFeedUrl    — last effective URL from linked web account
'   deviceId         — stable device id for pairing
'   deviceToken      — bearer token after web claim
'   linkedEmail      — last known account email
'
' Package config: pkg:/config/channel.json (apiBaseUrl, defaultFeedUrl).
' Edit that file before packaging — not user-configurable on device.

function FeedRegistry() as Object
    return CreateObject("roRegistrySection", "feed")
end function

function LoadChannelConfig() as Object
    raw = ReadAsciiFile("pkg:/config/channel.json")
    if raw = invalid or raw = ""
        return {}
    end if
    parsed = ParseJson(raw)
    if parsed = invalid
        return {}
    end if
    return parsed
end function

function GetDefaultFeedUrl() as String
    config = LoadChannelConfig()
    if config <> invalid and config.defaultFeedUrl <> invalid and config.defaultFeedUrl <> ""
        return config.defaultFeedUrl
    end if
    return "https://f004.backblazeb2.com/file/roku-hockey/secretfeedfilename.json"
end function

' Backend origin from pkg:/config/channel.json (no trailing slash).
function GetApiBaseUrl() as String
    config = LoadChannelConfig()
    url = ""
    if config <> invalid and config.apiBaseUrl <> invalid
        url = config.apiBaseUrl
    end if
    if url = invalid or url = ""
        return ""
    end if
    if Right(url, 1) = "/"
        return Left(url, Len(url) - 1)
    end if
    return url
end function

function GetOrCreateDeviceId() as String
    section = FeedRegistry()
    if section.Exists("deviceId")
        value = section.Read("deviceId")
        if value <> invalid and value <> ""
            return value
        end if
    end if
    deviceInfo = CreateObject("roDeviceInfo")
    id = ""
    if deviceInfo <> invalid
        id = deviceInfo.GetRandomUUID()
    end if
    if id = invalid or id = ""
        dt = CreateObject("roDateTime")
        id = "roku-" + dt.AsSeconds().ToStr()
    end if
    section.Write("deviceId", id)
    section.Flush()
    return id
end function

function GetDeviceAccessToken() as String
    section = FeedRegistry()
    if section.Exists("deviceToken")
        value = section.Read("deviceToken")
        if value <> invalid
            return value
        end if
    end if
    return ""
end function

function SetDeviceAccessToken(token as String) as Void
    section = FeedRegistry()
    section.Write("deviceToken", token)
    section.Flush()
end function

function GetLinkedEmail() as String
    section = FeedRegistry()
    if section.Exists("linkedEmail")
        value = section.Read("linkedEmail")
        if value <> invalid
            return value
        end if
    end if
    return ""
end function

function SetLinkedEmail(email as String) as Void
    section = FeedRegistry()
    if email = ""
        if section.Exists("linkedEmail")
            section.Delete("linkedEmail")
        end if
    else
        section.Write("linkedEmail", email)
    end if
    section.Flush()
end function

function IsAccountLinked() as Boolean
    return GetDeviceAccessToken() <> ""
end function

sub ClearDeviceLink()
    section = FeedRegistry()
    for each key in ["deviceToken", "linkedEmail", "syncedFeedUrl", "apiBaseUrl"]
        if section.Exists(key)
            section.Delete(key)
        end if
    end for
    section.Flush()
end sub

function GetCustomFeedUrl() as String
    section = FeedRegistry()
    if section.Exists("feedUrl")
        value = section.Read("feedUrl")
        if value <> invalid
            return value
        end if
    end if
    return ""
end function

function GetSyncedFeedUrl() as String
    section = FeedRegistry()
    if section.Exists("syncedFeedUrl")
        value = section.Read("syncedFeedUrl")
        if value <> invalid
            return value
        end if
    end if
    return ""
end function

function SetSyncedFeedUrl(url as String) as Void
    section = FeedRegistry()
    if url = ""
        if section.Exists("syncedFeedUrl")
            section.Delete("syncedFeedUrl")
        end if
    else
        section.Write("syncedFeedUrl", url)
    end if
    section.Flush()
end function

' Priority: account-synced URL (when linked) > local override > built-in default
function GetFeedUrl() as String
    if IsAccountLinked()
        synced = GetSyncedFeedUrl()
        if synced <> ""
            return synced
        end if
    end if
    customUrl = GetCustomFeedUrl()
    if customUrl <> ""
        return customUrl
    end if
    return GetDefaultFeedUrl()
end function

function IsValidFeedUrl(url as String) as Boolean
    if url = invalid or Len(url) = 0
        return false
    end if
    lowerUrl = LCase(url)
    if Left(lowerUrl, 8) = "https://" or Left(lowerUrl, 7) = "http://"
        return true
    end if
    return false
end function

function SetFeedUrl(url as String) as Boolean
    if not IsValidFeedUrl(url)
        return false
    end if
    section = FeedRegistry()
    section.Write("feedUrl", url)
    section.Flush()
    return true
end function

sub ClearFeedUrl()
    section = FeedRegistry()
    if section.Exists("feedUrl")
        section.Delete("feedUrl")
        section.Flush()
    end if
end sub

function CreateJsonTransfer(url as String) as Object
    xfer = CreateObject("roURLTransfer")
    xfer.SetCertificatesFile("common:/certs/ca-bundle.crt")
    xfer.InitClientCertificates()
    xfer.SetURL(url)
    xfer.AddHeader("Content-Type", "application/json")
    xfer.AddHeader("Accept", "application/json")
    return xfer
end function

function ParseJsonResponse(body as String) as Object
    if body = invalid or body = ""
        return invalid
    end if
    return ParseJson(body)
end function

' Pull effectiveFeedUrl from backend when linked. Returns true if sync updated URL.
' Short timeout so a dead API cannot block channel load.
function SyncFeedFromAccount() as Boolean
    apiBase = GetApiBaseUrl()
    token = GetDeviceAccessToken()
    if apiBase = "" or token = ""
        return false
    end if

    xfer = CreateJsonTransfer(apiBase + "/device/settings")
    xfer.AddHeader("Authorization", "Bearer " + token)
    port = CreateObject("roMessagePort")
    xfer.SetMessagePort(port)
    if not xfer.AsyncGetToString()
        return false
    end if
    msg = wait(5000, port)
    if msg = invalid or type(msg) <> "roUrlEvent"
        xfer.AsyncCancel()
        return false
    end if
    if msg.GetResponseCode() < 200 or msg.GetResponseCode() >= 300
        return false
    end if
    json = ParseJsonResponse(msg.GetString())
    if json = invalid or json.ok <> true or json.settings = invalid
        return false
    end if

    effectiveUrl = json.settings.effectiveFeedUrl
    if effectiveUrl = invalid or effectiveUrl = ""
        return false
    end if

    SetSyncedFeedUrl(effectiveUrl)
    if json.settings.email <> invalid
        SetLinkedEmail(json.settings.email)
    end if
    return true
end function
