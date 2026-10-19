; installer/hibana.nsi — the NSIS installer spec (WINDOWS-PACKAGING-PLAN.md §4).
; M5 ARTIFACT — the skeleton carries the real structure; the wails build's
; own -nsis path can consume its generated project instead, but the CONTRACTS
; below are the spec the final installer must honor:
;   * per-user install into %LOCALAPPDATA%\Programs\hibana (no UAC)
;   * WebView2 Evergreen probe + bootstrapper offer (§4.2)
;   * silent /S for scripting + the future auto-update path (§4.3)
;   * "leaves no residue" uninstall (§4.4): app dir + shortcuts + the
;     %LOCALAPPDATA%\hibana data dir ONLY when the user opts in
;   * never touches a portable-mode data dir (the never-mix rule §1)

!define APPNAME "Hibana Kanban"
!define EXENAME "hibana.exe"
!define APPDIR  "$LOCALAPPDATA\Programs\hibana"

Name "${APPNAME}"
OutFile "hibana-setup-${VERSION}.exe"       ; stamped by the CI release step
InstallDir "${APPDIR}"
RequestExecutionLevel user                  ; per-user — no UAC (WPP §1.1)

Page directory
Page instfiles

Section "Install"
  SetOutPath "$INSTDIR"
  File "..\build\bin\hibana.exe"            ; the wails build output
  CreateShortCut "$SMPROGRAMS\Hibana Kanban.lnk" "$INSTDIR\${EXENAME}"
  ; TODO(M5): WebView2 Evergreen probe:
  ;   ReadRegStr $0 HKLM "SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" "pv"
  ;   ${If} $0 == "" → Download + run the Evergreen bootstrapper
  ;     https://go.microsoft.com/fwlink/p/?LinkId=2124703  (silent: /silent /install)
  ;   (WPP §2/§4.2 — the same probe+fallback the app itself ships at first run)
  WriteUninstaller "$INSTDIR\uninstall.exe"
SectionEnd

Section "Uninstall"
  ; §4.4 leaves-no-residue contract. The DATA dir (%LOCALAPPDATA%\hibana) is
  ; offered as an explicit checkbox — never silently deleted (it may hold
  ; unsynced offline edits).
  Delete "$SMPROGRAMS\Hibana Kanban.lnk"
  Delete "$INSTDIR\${EXENAME}"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"
  ; TODO(M5): MessageBox MB_YESNO "Also remove your Hibana data (offline mirror + session)?" IDNO skip
  ;   RMDir /r "$LOCALAPPDATA\hibana"
  ; skip:
SectionEnd
