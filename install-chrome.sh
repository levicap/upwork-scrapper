#!/bin/bash
set -e

echo "Installing Chrome/Chromium..."

# Update package list
apt-get update

# Try to install Chrome first
if wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add - 2>/dev/null; then
    echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list
    apt-get update
    apt-get install -y google-chrome-stable && echo "✅ Google Chrome installed" && exit 0
fi

# Fallback to Chromium
apt-get install -y chromium chromium-driver && echo "✅ Chromium installed" && exit 0

echo "❌ Failed to install Chrome or Chromium"
exit 1
