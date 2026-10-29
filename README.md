# Twitch to Kick Bridge

Shows a Kick profile button on Twitch channels when the streamer is also on Kick.

An extension like this wasn't available, and let's face it. It's hard to know what streamers are using Kick or not.


Steps:

1. Open Edge or Chrome, press 'Load Unpacked' then click on the 'Twitch to Kick Bridge' folder.
2. Create a Kick App: https://kick.com/settings/developer
3. Copy Client ID/Client Secret
4. Open Extension, click on Settings
5. Paste Kick's Client ID and Secret then press save.
6. Create a Twitch App: https://dev.twitch.tv/console/apps
7. Category: Browser Extension
8. Copy Client ID, make public. No Secret Needed
9. In OAuth Redirect URLs, put `http://localhost` save.
10. Open Extension settings, under 'Twitch' paste your Client ID, underneath you'll find a special URL named OAuth Redirect URLs. Press 'Add' in Twitch Dev Console and press save.


Once extension is added and if you want to update this app again, go to 'Manage Extensions' > Find 'Twitch to Kick Bridge' > Press 'Reload' 

Settings:
The refresh button -
- Click: it refreshes live status for everyone on Kick, plus checks anything unchecked or failed, and anything marked “not on Kick” for over a week.
- Shift+click: it re-checks every follow from scratch.

-----

If you'd like to contribute to this, feel free to fork it, list your changes and I can update it.
