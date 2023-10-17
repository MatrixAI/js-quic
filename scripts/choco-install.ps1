function Save-ChocoPackage {
  param (
      $PackageName
  )
  Rename-Item -Path "$env:ChocolateyInstall\lib\$PackageName\$PackageName.nupkg" -NewName "$PackageName.nupkg.zip" -ErrorAction:SilentlyContinue
  Expand-Archive -LiteralPath "$env:ChocolateyInstall\lib\$PackageName\$PackageName.nupkg.zip" -DestinationPath "$env:ChocolateyInstall\lib\$PackageName" -Force
  Remove-Item "$env:ChocolateyInstall\lib\$PackageName\_rels" -Recurse
  Remove-Item "$env:ChocolateyInstall\lib\$PackageName\package" -Recurse
  Remove-Item "$env:ChocolateyInstall\lib\$PackageName\[Content_Types].xml"
  New-Item -Path "${PSScriptRoot}\..\tmp\chocolatey\$PackageName" -ItemType "directory" -ErrorAction:SilentlyContinue
  choco pack "$env:ChocolateyInstall\lib\$PackageName\$PackageName.nuspec" --outdir "${PSScriptRoot}\..\tmp\chocolatey\$PackageName"
}

# Check for existence of required environment variables
if ( $null -eq $env:ChocolateyInstall ) {
  [Console]::Error.WriteLine('Missing $env:ChocolateyInstall environment variable')
  exit 1
}

# Add the cached packages with source priority 1 (Chocolatey community is 0)
New-Item -Path "${PSScriptRoot}\..\tmp\chocolatey" -ItemType "directory" -ErrorAction:SilentlyContinue
choco source add --name="cache" --source="${PSScriptRoot}\..\tmp\chocolatey" --priority=1

# Install nodejs v20.5.1 (will use cache if exists)
$nodejs = "nodejs"
choco install "$nodejs" --version="20.5.1" --require-checksums -y
# Internalise nodejs to cache if doesn't exist
if ( -not (Test-Path -Path "${PSScriptRoot}\..\tmp\chocolatey\$nodejs\$nodejs.20.5.1.nupkg" -PathType Leaf) ) {
  Save-ChocoPackage -PackageName $nodejs
}

# Install rust v1.68.0 (will use cache if exists)
$rust = "rust-ms"
choco install "$rust" --version="1.68.0" --require-checksums -y
# Internalise rust to cache if doesn't exist
if ( -not (Test-Path -Path "${PSScriptRoot}\..\tmp\chocolatey\$rust\$rust.1.68.0.nupkg" -PathType Leaf) ) {
  Save-ChocoPackage -PackageName $rust
}

# Install llvm v16.0.3 (will use cache if exists)
$llvm = "llvm"
choco install "$llvm" --version="16.0.3" --require-checksums -y
# Internalise rust to cache if doesn't exist
if ( -not (Test-Path -Path "${PSScriptRoot}\..\tmp\chocolatey\$llvm\$llvm.16.0.3.nupkg" -PathType Leaf) ) {
  Save-ChocoPackage -PackageName $llvm
}

# Install nasm v2.16.01.20221231 (will use cache if exists)
$nasm = "nasm"
choco install "$nasm" --version="2.16.01.20221231" --require-checksums -y
# Internalise rust to cache if doesn't exist
if ( -not (Test-Path -Path "${PSScriptRoot}\..\tmp\chocolatey\$nasm\$nasm.2.16.01.20221231.nupkg" -PathType Leaf) ) {
  Save-ChocoPackage -PackageName $nasm
}

# Install Windows SDK v10.0.22621.2 (will use cache if exists)
$windowsSdk = "windows-sdk-11-version-22h2-all"
choco install $windowsSdk --version="10.0.22621.2" --require-checksums -y
# Internalise rust to cache if doesn't exist
if ( -not (Test-Path -Path "${PSScriptRoot}\..\tmp\chocolatey\$windowsSdk\$windowsSdk.10.0.22621.2.nupkg" -PathType Leaf) ) {
  Save-ChocoPackage -PackageName $windowsSdk
}
