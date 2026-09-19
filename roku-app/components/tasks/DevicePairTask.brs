sub Init()
    m.top.functionName = "RunPairing"
    m.top.cancel = false
end sub

sub RunPairing()
    apiBase = m.top.apiBaseUrl
    if apiBase = invalid or apiBase = ""
        apiBase = GetApiBaseUrl()
    end if
    if apiBase = ""
        m.top.status = "error"
        m.top.message = "Set API base URL first"
        return
    end if
    if Right(apiBase, 1) = "/"
        apiBase = Left(apiBase, Len(apiBase) - 1)
    end if

    deviceId = GetOrCreateDeviceId()
    m.top.status = "starting"
    m.top.message = "Starting pairing…"

    xfer = CreateJsonTransfer(apiBase + "/device/pair/start")
    requestBody = { deviceId: deviceId }
    response = xfer.PostFromString(FormatJson(requestBody))
    json = ParseJsonResponse(response)

    if json = invalid or json.ok <> true or json.code = invalid
        m.top.status = "error"
        m.top.message = "Could not start pairing"
        return
    end if

    if json.deviceId <> invalid and json.deviceId <> ""
        section = FeedRegistry()
        section.Write("deviceId", json.deviceId)
        section.Flush()
        deviceId = json.deviceId
    end if

    m.top.code = json.code
    m.top.status = "pending"
    m.top.message = "Enter this code on the web settings page"

    pollMs = 2000
    if json.pollAfterMs <> invalid
        pollMs = json.pollAfterMs
    end if

    maxLoops = 450
    i = 0
    while i < maxLoops
        if m.top.cancel = true
            m.top.status = "cancelled"
            m.top.message = "Pairing cancelled"
            return
        end if

        Sleep(pollMs)

        statusXfer = CreateJsonTransfer(apiBase + "/device/pair/status?deviceId=" + deviceId)
        statusBody = statusXfer.GetToString()
        statusJson = ParseJsonResponse(statusBody)

        if statusJson <> invalid
            if statusJson.status = "linked" and statusJson.linked = true
                if statusJson.accessToken <> invalid and statusJson.accessToken <> ""
                    SetDeviceAccessToken(statusJson.accessToken)
                end if
                if statusJson.effectiveFeedUrl <> invalid and statusJson.effectiveFeedUrl <> ""
                    SetSyncedFeedUrl(statusJson.effectiveFeedUrl)
                    m.top.effectiveFeedUrl = statusJson.effectiveFeedUrl
                end if
                if statusJson.email <> invalid
                    SetLinkedEmail(statusJson.email)
                    m.top.email = statusJson.email
                end if
                SetApiBaseUrl(apiBase)
                m.top.accessToken = GetDeviceAccessToken()
                m.top.status = "linked"
                m.top.message = "Linked"
                return
            else if statusJson.status = "expired"
                m.top.status = "expired"
                m.top.message = "Code expired. Try again."
                return
            end if
        end if

        i = i + 1
    end while

    m.top.status = "expired"
    m.top.message = "Pairing timed out"
end sub
