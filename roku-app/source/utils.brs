' Helper function convert AA to Node
function ContentListToSimpleNode(contentList as Object, nodeType = "ContentNode" as String) as Object
    result = CreateObject("roSGNode", nodeType) ' create node instance based on specified nodeType
    if result <> invalid
        ' go through contentList and create node instance for each item of list
        for each itemAA in contentList
            item = CreateObject("roSGNode", nodeType)
            item.SetFields(itemAA)
            result.AppendChild(item) 
        end for
    end if
    return result
end function

' Helper function convert seconds to mm:ss format
' getTime(138) returns 2:18
function GetTime(length as Integer) as String
    hours = length \ 3600
    minutes = (length \ 60) MOD 60

    if hours > 0
        minutesStr = minutes.ToStr()
        if minutes < 10
            minutesStr = "0" + minutesStr
        end if
        return hours.ToStr() + ":" + minutesStr
    else
        minutesStr = minutes.ToStr()
        secondsStr = (length mod 60).toStr()
        if (length mod 60) < 10
            secondsStr = "0" + secondsStr
        end if
        return minutesStr + ":" + secondsStr
    end if
end function

function Get12HourTime(dt as Object) as String
    hours = dt.GetHours()
    minutes = dt.GetMinutes()
    ampm = "AM"
    if hours >= 12
        ampm = "PM"
    end if
    if hours > 12
        hours = hours - 12
    end if
    if hours = 0
        hours = 12
    end if
    
    minutesStr = minutes.ToStr()
    if minutes < 10
        minutesStr = "0" + minutesStr
    end if
    
    return hours.ToStr() + ":" + minutesStr + " " + ampm
end function