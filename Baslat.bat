@echo off
title Converter Hub
cd /d "%~dp0"
call pnpm go
if errorlevel 1 (
  echo.
  echo Bir hata olustu. Pencereyi kapatmadan yukaridaki mesaji oku.
  pause
)
