#!/bin/bash

# Micracode Installer Script
# Usage: curl -sSL https://raw.githubusercontent.com/YOUR_USERNAME/micracode/main/install.sh | bash

set -e

REPO_URL="https://github.com/YOUR_USERNAME/micracode.git"
INSTALL_DIR="$HOME/.micracode"

echo "🚀 Installing Micracode..."

# Check for Python 3.13+
if ! command -v python3 &> /dev/null; then
    echo "❌ Python 3 is required but not installed."
    exit 1
fi

PYTHON_VERSION=$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
REQUIRED_VERSION="3.13"

if [ "$(printf '%s\n' "$REQUIRED_VERSION" "$PYTHON_VERSION" | sort -V | head -n1)" != "$REQUIRED_VERSION" ]; then
    echo "❌ Python $REQUIRED_VERSION or higher is required. You have Python $PYTHON_VERSION"
    exit 1
fi

# Check for pip
if ! command -v pip3 &> /dev/null; then
    echo "❌ pip3 is required but not installed."
    exit 1
fi

# Check for git
if ! command -v git &> /dev/null; then
    echo "❌ git is required but not installed."
    exit 1
fi

# Clone or update the repository
if [ -d "$INSTALL_DIR" ]; then
    echo "📦 Updating existing installation..."
    cd "$INSTALL_DIR"
    git pull --quiet
else
    echo "📦 Cloning repository..."
    git clone --quiet "$REPO_URL" "$INSTALL_DIR"
    cd "$INSTALL_DIR"
fi

# Install the package
echo "📥 Installing dependencies..."
pip3 install --quiet --user .

# Verify installation
if command -v micracode &> /dev/null; then
    echo ""
    echo "✅ Micracode installed successfully!"
    echo ""
    echo "Run 'micracode' to start the application."
else
    # Add ~/.local/bin to PATH hint
    echo ""
    echo "✅ Installation complete!"
    echo ""
    echo "⚠️  You may need to add ~/.local/bin to your PATH:"
    echo "   export PATH=\"\$HOME/.local/bin:\$PATH\""
    echo ""
    echo "Then run 'micracode' to start the application."
fi
