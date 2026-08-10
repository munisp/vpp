#!/bin/bash

# VPP Consumer Platform - Firebase Setup Automation
# Automates Firebase project configuration and setup

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo "======================================"
echo "VPP Platform - Firebase Setup"
echo "======================================"
echo ""

# Navigate to project root
cd "$(dirname "$0")/.."

echo -e "${BLUE}This script will help you set up Firebase for the VPP Platform${NC}"
echo ""

# Check if Firebase CLI is installed
if ! command -v firebase &> /dev/null; then
  echo -e "${YELLOW}Firebase CLI not found${NC}"
  echo "Installing Firebase CLI..."
  npm install -g firebase-tools
  echo -e "${GREEN}✓ Firebase CLI installed${NC}"
else
  echo -e "${GREEN}✓ Firebase CLI found${NC}"
fi

echo ""

# Login to Firebase
echo "Logging in to Firebase..."
firebase login

if [ $? -ne 0 ]; then
  echo -e "${RED}❌ Firebase login failed${NC}"
  exit 1
fi

echo -e "${GREEN}✓ Logged in to Firebase${NC}"
echo ""

# Create or select Firebase project
echo "======================================"
echo "Firebase Project Setup"
echo "======================================"
echo ""

read -p "Do you want to (1) Create new project or (2) Use existing project? (1/2): " PROJECT_CHOICE

if [ "$PROJECT_CHOICE" = "1" ]; then
  # Create new project
  echo ""
  read -p "Enter project ID (e.g., vpp-platform): " PROJECT_ID
  read -p "Enter project display name (e.g., VPP Consumer Platform): " PROJECT_NAME
  
  echo "Creating Firebase project..."
  firebase projects:create "$PROJECT_ID" --display-name "$PROJECT_NAME"
  
  if [ $? -eq 0 ]; then
    echo -e "${GREEN}✓ Firebase project created${NC}"
  else
    echo -e "${RED}❌ Failed to create project${NC}"
    exit 1
  fi
else
  # Use existing project
  echo ""
  echo "Available Firebase projects:"
  firebase projects:list
  echo ""
  read -p "Enter project ID: " PROJECT_ID
fi

# Initialize Firebase in project
echo ""
echo "Initializing Firebase..."
firebase use "$PROJECT_ID"

if [ $? -ne 0 ]; then
  echo -e "${RED}❌ Failed to select project${NC}"
  exit 1
fi

echo -e "${GREEN}✓ Firebase project selected: $PROJECT_ID${NC}"
echo ""

# Enable Analytics
echo "======================================"
echo "Enable Google Analytics"
echo "======================================"
echo ""

read -p "Enable Google Analytics? (y/n): " ENABLE_ANALYTICS

if [[ $REPLY =~ ^[Yy]$ ]]; then
  echo "Enabling Google Analytics..."
  # Note: This typically requires manual setup in Firebase Console
  echo -e "${YELLOW}⚠ Please enable Google Analytics manually in Firebase Console${NC}"
  echo "1. Go to https://console.firebase.google.com/project/$PROJECT_ID/settings/general"
  echo "2. Scroll to 'Your apps' section"
  echo "3. Click 'Enable Google Analytics'"
  echo ""
  read -p "Press Enter when done..."
fi

# Register Web App
echo ""
echo "======================================"
echo "Register Web App"
echo "======================================"
echo ""

read -p "Register web app? (y/n): " REGISTER_WEB

if [[ $REPLY =~ ^[Yy]$ ]]; then
  read -p "Enter web app nickname (e.g., VPP Web Platform): " WEB_APP_NAME
  
  echo "Registering web app..."
  firebase apps:create WEB "$WEB_APP_NAME"
  
  if [ $? -eq 0 ]; then
    echo -e "${GREEN}✓ Web app registered${NC}"
    
    # Get web app config
    echo ""
    echo "Fetching web app configuration..."
    WEB_APP_ID=$(firebase apps:list WEB --json | grep -o '"appId":"[^"]*' | head -1 | cut -d'"' -f4)
    
    if [ -n "$WEB_APP_ID" ]; then
      firebase apps:sdkconfig WEB "$WEB_APP_ID" > firebase-web-config.json
      echo -e "${GREEN}✓ Web app configuration saved to firebase-web-config.json${NC}"
    fi
  else
    echo -e "${YELLOW}⚠ Failed to register web app${NC}"
  fi
fi

# Register iOS App
echo ""
echo "======================================"
echo "Register iOS App"
echo "======================================"
echo ""

read -p "Register iOS app? (y/n): " REGISTER_IOS

if [[ $REPLY =~ ^[Yy]$ ]]; then
  IOS_BUNDLE_ID="com.vpp.consumer"
  read -p "Enter iOS bundle ID [$IOS_BUNDLE_ID]: " INPUT_IOS_BUNDLE_ID
  IOS_BUNDLE_ID=${INPUT_IOS_BUNDLE_ID:-$IOS_BUNDLE_ID}
  
  read -p "Enter iOS app nickname (e.g., VPP iOS): " IOS_APP_NAME
  
  echo "Registering iOS app..."
  firebase apps:create IOS "$IOS_BUNDLE_ID" --display-name "$IOS_APP_NAME"
  
  if [ $? -eq 0 ]; then
    echo -e "${GREEN}✓ iOS app registered${NC}"
    
    # Download GoogleService-Info.plist
    echo ""
    echo "Downloading GoogleService-Info.plist..."
    IOS_APP_ID=$(firebase apps:list IOS --json | grep -o '"appId":"[^"]*' | head -1 | cut -d'"' -f4)
    
    if [ -n "$IOS_APP_ID" ]; then
      firebase apps:sdkconfig IOS "$IOS_APP_ID" > mobile/ios/GoogleService-Info.plist
      echo -e "${GREEN}✓ GoogleService-Info.plist saved to mobile/ios/${NC}"
    fi
  else
    echo -e "${YELLOW}⚠ Failed to register iOS app${NC}"
  fi
fi

# Register Android App
echo ""
echo "======================================"
echo "Register Android App"
echo "======================================"
echo ""

read -p "Register Android app? (y/n): " REGISTER_ANDROID

if [[ $REPLY =~ ^[Yy]$ ]]; then
  ANDROID_PACKAGE="com.vpp.consumer"
  read -p "Enter Android package name [$ANDROID_PACKAGE]: " INPUT_ANDROID_PACKAGE
  ANDROID_PACKAGE=${INPUT_ANDROID_PACKAGE:-$ANDROID_PACKAGE}
  
  read -p "Enter Android app nickname (e.g., VPP Android): " ANDROID_APP_NAME
  
  echo "Registering Android app..."
  firebase apps:create ANDROID "$ANDROID_PACKAGE" --display-name "$ANDROID_APP_NAME"
  
  if [ $? -eq 0 ]; then
    echo -e "${GREEN}✓ Android app registered${NC}"
    
    # Download google-services.json
    echo ""
    echo "Downloading google-services.json..."
    ANDROID_APP_ID=$(firebase apps:list ANDROID --json | grep -o '"appId":"[^"]*' | head -1 | cut -d'"' -f4)
    
    if [ -n "$ANDROID_APP_ID" ]; then
      firebase apps:sdkconfig ANDROID "$ANDROID_APP_ID" > mobile/android/app/google-services.json
      echo -e "${GREEN}✓ google-services.json saved to mobile/android/app/${NC}"
    fi
  else
    echo -e "${YELLOW}⚠ Failed to register Android app${NC}"
  fi
fi

# Generate environment variables
echo ""
echo "======================================"
echo "Generate Environment Variables"
echo "======================================"
echo ""

if [ -f "firebase-web-config.json" ]; then
  echo "Generating .env file..."
  
  # Parse Firebase config
  API_KEY=$(grep -o '"apiKey":"[^"]*' firebase-web-config.json | cut -d'"' -f4)
  AUTH_DOMAIN=$(grep -o '"authDomain":"[^"]*' firebase-web-config.json | cut -d'"' -f4)
  PROJECT_ID=$(grep -o '"projectId":"[^"]*' firebase-web-config.json | cut -d'"' -f4)
  STORAGE_BUCKET=$(grep -o '"storageBucket":"[^"]*' firebase-web-config.json | cut -d'"' -f4)
  MESSAGING_SENDER_ID=$(grep -o '"messagingSenderId":"[^"]*' firebase-web-config.json | cut -d'"' -f4)
  APP_ID=$(grep -o '"appId":"[^"]*' firebase-web-config.json | cut -d'"' -f4)
  MEASUREMENT_ID=$(grep -o '"measurementId":"[^"]*' firebase-web-config.json | cut -d'"' -f4)
  
  # Create .env.firebase file
  cat > .env.firebase << EOF
# Firebase Configuration
# Add these to your .env file

# Firebase Web Configuration
VITE_FIREBASE_API_KEY=$API_KEY
VITE_FIREBASE_AUTH_DOMAIN=$AUTH_DOMAIN
VITE_FIREBASE_PROJECT_ID=$PROJECT_ID
VITE_FIREBASE_STORAGE_BUCKET=$STORAGE_BUCKET
VITE_FIREBASE_MESSAGING_SENDER_ID=$MESSAGING_SENDER_ID
VITE_FIREBASE_APP_ID=$APP_ID
VITE_FIREBASE_MEASUREMENT_ID=$MEASUREMENT_ID
EOF

  echo -e "${GREEN}✓ Environment variables saved to .env.firebase${NC}"
  echo ""
  echo "Add these variables to your .env file:"
  cat .env.firebase
  echo ""
else
  echo -e "${YELLOW}⚠ Firebase config not found, skipping environment variable generation${NC}"
fi

# Summary
echo ""
echo "======================================"
echo "Setup Complete!"
echo "======================================"
echo ""

echo -e "${GREEN}Firebase project setup completed successfully!${NC}"
echo ""
echo "Next steps:"
echo ""
echo "1. Add environment variables to .env file:"
echo "   cat .env.firebase >> .env"
echo ""
echo "2. Verify Firebase configuration in Firebase Console:"
echo "   https://console.firebase.google.com/project/$PROJECT_ID"
echo ""
echo "3. Enable required Firebase services:"
echo "   - Analytics (if not already enabled)"
echo "   - Cloud Messaging (for push notifications)"
echo "   - Authentication (if using Firebase Auth)"
echo ""
echo "4. Test Firebase integration:"
echo "   - Run the web app: pnpm dev"
echo "   - Check browser console for Firebase initialization"
echo "   - Verify events in Firebase Console → Analytics → DebugView"
echo ""
echo "5. Deploy Firebase configuration to production:"
echo "   - Update production environment variables"
echo "   - Rebuild and deploy applications"
echo ""

# Cleanup
if [ -f "firebase-web-config.json" ]; then
  echo "Cleaning up temporary files..."
  rm firebase-web-config.json
fi

echo ""
echo -e "${GREEN}✓ All done!${NC}"
echo ""
