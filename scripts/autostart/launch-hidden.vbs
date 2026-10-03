' Chay dashboard (va agent ben trong no) an, khong mo cua so console nao.
' Shortcut trong thu muc Startup cua Windows goi file nay moi lan dang nhap - xem install.ps1.
'
' Tham so 1: duong dan day du toi node.exe. Ghi san vao shortcut luc cai dat thay vi tim trong PATH,
' vi PATH luc vua dang nhap co the chua du (nvm-windows, cai node cho mot user).
'
' File nay CO Y chi dung ky tu ASCII: wscript doc .vbs theo bang ma ANSI, tieng Viet co dau se loi.
Option Explicit

Dim fso, shell, repo, node
Set fso = CreateObject("Scripting.FileSystemObject")
repo = fso.GetParentFolderName(fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName)))

If WScript.Arguments.Count > 0 Then
    node = WScript.Arguments(0)
Else
    node = "node"
End If

Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = repo
' 0 = an cua so, False = khong cho tien trinh ket thuc.
shell.Run """" & node & """ --import tsx src/dashboard/main.ts", 0, False
