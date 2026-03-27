[Setup]
AppName=IEDF-Nanolino-
AppVersion=1.1.0
AppPublisher=Universität Basel/ Paul Hiret
AppPublisherURL=mailto:paul.hiret@unibas.ch
DefaultDirName={pf}\IEDF-Nanolino
DefaultGroupName=IEDF-Nanolino-
DisableProgramGroupPage=yes
OutputDir=installer
OutputBaseFilename=IEDF-Nanolino-_setup
SetupIconFile=icon.ico
Compression=lzma
SolidCompression=yes
WizardStyle=modern

[Files]
Source: "dist\IEDF-Nanolino\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs

[Icons]
Name: "{group}\IEDFby"; Filename: "{app}\IEDF-Nanolino.exe"
Name: "{commondesktop}\IEDF-Nanolino"; Filename: "{app}\IEDF-Nanolino.exe"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Create a desktop icon"; GroupDescription: "Additional icons:"

[Run]
Filename: "{app}\IEDF-Nanolino.exe"; Description: "Launch RFEA Analyser"; Flags: nowait postinstall skipifsilent
