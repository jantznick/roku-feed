' Feed URL configuration helpers.
' Custom URL is stored in roRegistry section "feed", key "feedUrl".
' Web/backend feed settings are separate; the Roku channel stores its URL locally.

function GetDefaultFeedUrl() as String
    return "https://f004.backblazeb2.com/file/roku-hockey/secretfeedfilename.json"
end function

function GetCustomFeedUrl() as String
    section = CreateObject("roRegistrySection", "feed")
    if section.Exists("feedUrl")
        value = section.Read("feedUrl")
        if value <> invalid
            return value
        end if
    end if
    return ""
end function

function GetFeedUrl() as String
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
    section = CreateObject("roRegistrySection", "feed")
    section.Write("feedUrl", url)
    section.Flush()
    return true
end function

sub ClearFeedUrl()
    section = CreateObject("roRegistrySection", "feed")
    if section.Exists("feedUrl")
        section.Delete("feedUrl")
        section.Flush()
    end if
end sub
