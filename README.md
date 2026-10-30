# Twitch to Kick Bridge

Shows a Kick profile button on Twitch channels when the streamer is also on Kick.

An extension like this wasn't available, and let's face it. It's hard to know what streamers are using Kick or not.

Steps:

1. Download Release, unzip.
2. Open Edge or Chrome, press 'Load Unpacked' then click on the 'Twitch to Kick Bridge' folder.
3. Create a Kick App: https://kick.com/settings/developer
4. Copy Client ID/Client Secret
5. Open Extension, click on Settings
6. Paste Kick's Client ID and Secret then press save.
7. Create a Twitch App: https://dev.twitch.tv/console/apps
8. Category: Browser Extension
9. Copy Client ID, make public. No Secret Needed
10. In OAuth Redirect URLs, put `http://localhost` save.
11. Open Extension settings, under 'Twitch' paste your Client ID, underneath you'll find a special URL named OAuth Redirect URLs. Press 'Add' in Twitch Dev Console and press save.

Once extension is added and if you want to update this extension again, download the newest release, unzip it, replace old files, go to 'Manage Extensions' > Find 'Twitch to Kick Bridge' > Press 'Reload' 

![Example / Preview](https://pbs.twimg.com/media/HV1reCDWkAExvnk?format=png "Example / Preview")

-----

If you'd like to contribute to this, feel free to fork it, list your changes and I can update it.
