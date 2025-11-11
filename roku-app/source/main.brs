' ********** Copyright 2016 Roku Corp.  All Rights Reserved. **********

' 1st function called when channel application starts.
sub Main()
  ShowChannelRSGScreen()
end sub

sub ShowChannelRSGScreen()
  'main canvas
  screen = CreateObject("roSGScreen")
  ' message port is where events are sent
  m.port = CreateObject("roMessagePort")
  ' set the port to the screen
  screen.SetMessagePort(m.port)
  ' every screen object must have a scene node
  scene = screen.CreateScene("MainScene")
  screen.Show()

  ' event loop
  while(true)
    ' waiting
    msg = wait(0, m.port)
    msgType = type(msg)
    if msgType = "roSCScreenEvent"
      if msg.IsScreenClosed() then return
    end if
  end while
end sub
