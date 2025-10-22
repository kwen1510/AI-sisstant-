#!/bin/bash

echo "🚀 Smart Classroom Transcription - Render Deployment Helper"
echo "=========================================================="
echo ""

# Check if git is installed
if ! command -v git &> /dev/null; then
    echo "❌ Git is not installed. Please install Git first."
    exit 1
fi

# Check if we're in a git repository
if [ ! -d ".git" ]; then
    echo "📁 Initializing git repository..."
    git init
    git add .
    git commit -m "Initial commit for Render deployment"
    echo "✅ Git repository initialized"
    echo ""
fi

echo "📋 Next Steps for Render Deployment:"
echo ""
echo "1. 📤 Push to GitHub:"
echo "   git remote add origin YOUR_GITHUB_REPO_URL"
echo "   git push -u origin main"
echo ""
echo "2. 🌐 Go to Render Dashboard:"
echo "   https://dashboard.render.com"
echo ""
echo "3. 🔧 Create New Web Service:"
echo "   - Connect your GitHub repository"
echo "   - Environment: Node"
echo "   - Build Command: npm install"
echo "   - Start Command: node index.js"
echo ""
echo "4. 🔑 Add Environment Variables:"
echo "   - ELEVENLABS_KEY: Your ElevenLabs API key"
echo "   - ANTHROPIC_KEY: Your Anthropic Claude API key"
echo "   - NODE_ENV: production"
echo ""
echo "5. 🚀 Deploy!"
echo ""
echo "📖 For detailed instructions, see README.md"
echo ""
echo "�� Happy Teaching!" 