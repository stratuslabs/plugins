-- Sends one text from this Mac's iMessage account.
-- argv: the recipient's handle, then the text. Both arrive as data, never
-- as script source, so nothing in a message can change what runs.
on run argv
	set targetHandle to item 1 of argv
	set messageText to item 2 of argv
	tell application "Messages"
		set targetAccount to 1st account whose service type = iMessage
		set targetParticipant to participant targetHandle of targetAccount
		send messageText to targetParticipant
	end tell
end run
