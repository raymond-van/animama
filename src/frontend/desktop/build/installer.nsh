; Animama's additions to electron-builder's per-user NSIS installer.

; Animama needs Windows 10 version 1903 (build 18362) or later, the same floor
; as the app's startup check and the staged runtime. A silent run exits with
; ERROR_OLD_WIN_VERSION (1150) instead of showing the message.
!macro customInit
  ReadRegStr $0 HKLM "SOFTWARE\Microsoft\Windows NT\CurrentVersion" "CurrentBuildNumber"
  ${If} $0 < 18362
    ${IfNot} ${Silent}
      MessageBox MB_OK|MB_ICONSTOP "Animama requires Windows 10 version 1903 or later."
    ${EndIf}
    SetErrorLevel 1150
    Quit
  ${EndIf}
!macroend

; Keep the user's data unless they explicitly choose to delete it. Only a
; person-started uninstall asks: one without /S on its command line. The
; one-click uninstaller switches itself to silent mode after its confirmation,
; so the silent flag cannot tell, and installers always run the old uninstaller
; with /S (an update also passes --updated).
;
; Every uninstall that is not part of an install removes Launch at login, so
; Windows does not keep starting a missing app. Electron names the entry after
; the AppUserModelId, which is the app ID. Installers always run the old
; uninstaller with --updated, so upgrades and reinstalls keep the setting.
!macro customUnInstall
  ${IfNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${APP_ID}"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "${APP_ID}"
  ${EndIf}
  Push $R0
  Push $R1
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "/S" $R1
  ${If} ${Errors}
  ${AndIfNot} ${isUpdated}
  ${AndIf} $LOCALAPPDATA != ""
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "Also delete your Animama data?$\r$\n$\r$\n$LOCALAPPDATA\Animama$\r$\n$\r$\nThis permanently removes your chats, Animas, Local content, settings, saved keys and downloaded speech models. Choose No to keep them for a later reinstall." IDNO animama_keep_data
    ; NSIS's RMDir /r follows directory junctions and would delete files
    ; outside the data folder; rd removes a junction without entering it.
    ; /v:off keeps a "!" in the profile path literal.
    nsExec::Exec '"$SYSDIR\cmd.exe" /d /v:off /c rd /s /q "$LOCALAPPDATA\Animama"'
    Pop $R1
    ${If} ${FileExists} "$LOCALAPPDATA\Animama\*.*"
      MessageBox MB_OK|MB_ICONEXCLAMATION "Some Animama data could not be deleted:$\r$\n$\r$\n$LOCALAPPDATA\Animama$\r$\n$\r$\nClose any program using it, then delete that folder yourself."
    ${EndIf}
    animama_keep_data:
  ${EndIf}
  Pop $R1
  Pop $R0
!macroend
