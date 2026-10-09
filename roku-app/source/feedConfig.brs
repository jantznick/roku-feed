' Feed URL + account sync helpers.
' Registry section "feed":
'   feedUrl          — optional local override (sideload/testing)
'   syncedFeedUrl    — last effective URL from linked web account
'   deviceId         — stable device id for pairing
'   deviceToken      — bearer token after web claim
'   linkedEmail      — last known account email
'
' Package config: pkg:/config/channel.json
'   (apiBaseUrl, defaultFeedUrl, optional feedSources[]).
' Edit that file before packaging — not user-configurable on device.
' Feed sources load independently with timeouts + cachefs stale-while-revalidate.

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

' HTTP GET with a hard timeout so one hung host cannot freeze the channel.
' Returns body string on success, otherwise "".
function HttpGetWithTimeout(url as String, timeoutMs = 15000 as Integer) as String
    if url = invalid or url = ""
        return ""
    end if
    if timeoutMs <= 0
        timeoutMs = 15000
    end if

    xfer = CreateObject("roURLTransfer")
    xfer.SetCertificatesFile("common:/certs/ca-bundle.crt")
    xfer.InitClientCertificates()
    xfer.SetURL(url)
    xfer.AddHeader("Accept", "application/json")
    port = CreateObject("roMessagePort")
    xfer.SetMessagePort(port)

    if not xfer.AsyncGetToString()
        return ""
    end if

    msg = wait(timeoutMs, port)
    if msg = invalid
        xfer.AsyncCancel()
        return ""
    end if
    if type(msg) <> "roUrlEvent"
        xfer.AsyncCancel()
        return ""
    end if

    code = msg.GetResponseCode()
    body = msg.GetString()
    if code < 200 or code >= 300
        return ""
    end if
    if body = invalid
        return ""
    end if
    return body
end function

function HttpGetJsonWithTimeout(url as String, timeoutMs = 15000 as Integer) as Object
    return ParseJsonResponse(HttpGetWithTimeout(url, timeoutMs))
end function

' Feed sources from channel.json feedSources[], or a single default source.
' Sources without an explicit url use GetFeedUrl() (account sync / override / default).
' Each source loads independently — one failure must not block the others.
function GetFeedSources() as Object
    sources = []
    config = LoadChannelConfig()
    configured = invalid
    if config <> invalid
        configured = config.feedSources
    end if

    if Type(configured) = "roArray" and configured.Count() > 0
        for each entry in configured
            if entry <> invalid
                id = entry.id
                if id = invalid or id = ""
                    id = "source"
                end if
                label = entry.label
                if label = invalid or label = ""
                    label = id
                end if
                url = ""
                if entry.url <> invalid and entry.url <> ""
                    url = entry.url
                else
                    url = GetFeedUrl()
                end if
                if IsValidFeedUrl(url)
                    timeoutMs = 20000
                    if entry.timeoutMs <> invalid
                        timeoutMs = entry.timeoutMs
                    end if
                    sources.Push({
                        id: id,
                        label: label,
                        url: url,
                        timeoutMs: timeoutMs
                    })
                end if
            end if
        end for
    end if

    if sources.Count() = 0
        sources.Push({
            id: "live",
            label: "Live",
            url: GetFeedUrl(),
            timeoutMs: 20000
        })
    end if
    return sources
end function

function FeedCachePath(sourceId as String) as String
    safeId = sourceId
    if safeId = invalid or safeId = ""
        safeId = "main"
    end if
    return "cachefs:/wls-feed-" + safeId + ".json"
end function

function LoadFeedCache(sourceId as String) as Object
    path = FeedCachePath(sourceId)
    raw = ReadAsciiFile(path)
    return ParseJsonResponse(raw)
end function

function SaveFeedCache(sourceId as String, body as String) as Boolean
    if body = invalid or body = ""
        return false
    end if
    path = FeedCachePath(sourceId)
    return WriteAsciiFile(path, body)
end function

function LoadMergedFeedCache() as Object
    return LoadFeedCache("merged")
end function

function SaveMergedFeedCache(json as Object) as Boolean
    if json = invalid
        return false
    end if
    body = FormatJson(json)
    if body = invalid or body = ""
        return false
    end if
    return SaveFeedCache("merged", body)
end function

' Pull effectiveFeedUrl from backend when linked. Returns true if sync updated URL.
' Uses a short timeout so a dead API cannot block Live TV / sports / other sources.
function SyncFeedFromAccount(timeoutMs = 5000 as Integer) as Boolean
    apiBase = GetApiBaseUrl()
    token = GetDeviceAccessToken()
    if apiBase = "" or token = ""
        return false
    end if
    if timeoutMs <= 0
        timeoutMs = 5000
    end if

    xfer = CreateJsonTransfer(apiBase + "/device/settings")
    xfer.AddHeader("Authorization", "Bearer " + token)
    port = CreateObject("roMessagePort")
    xfer.SetMessagePort(port)
    if not xfer.AsyncGetToString()
        return false
    end if
    msg = wait(timeoutMs, port)
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
