#!/bin/bash

# VPP Consumer Platform - Production Build Script
# Automates the production build process for iOS and Android

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo "======================================"
echo "VPP Mobile App - Production Build"
echo "======================================"
echo ""

# Check if platform is specified
if [ -z "$1" ]; then
  echo -e "${YELLOW}Usage: ./build-production.sh [ios|android|both] [version]${NC}"
  echo ""
  echo "Examples:"
  echo "  ./build-production.sh ios 1.0.1"
  echo "  ./build-production.sh android 1.0.1"
  echo "  ./build-production.sh both 1.0.1"
  exit 1
fi

PLATFORM=$1
VERSION=${2:-"1.0.0"}

# Navigate to mobile directory
cd "$(dirname "$0")/.."

echo -e "${BLUE}Platform: $PLATFORM${NC}"
echo -e "${BLUE}Version: $VERSION${NC}"
echo ""

# Check if EAS CLI is installed
if ! command -v eas &> /dev/null; then
  echo -e "${RED}❌ EAS CLI not found${NC}"
  echo "Installing EAS CLI..."
  npm install -g eas-cli
fi

# Check if logged in to EAS
echo "Checking EAS authentication..."
if ! eas whoami &> /dev/null; then
  echo -e "${YELLOW}Not logged in to EAS${NC}"
  echo "Please login:"
  eas login
fi

echo -e "${GREEN}✓ Authenticated with EAS${NC}"
echo ""

# Function to update version in app.json
update_version() {
  echo "Updating version to $VERSION..."
  
  # Use node to update app.json
  node -e "
    const fs = require('fs');
    const appJson = JSON.parse(fs.readFileSync('app.json', 'utf8'));
    appJson.expo.version = '$VERSION';
    fs.writeFileSync('app.json', JSON.stringify(appJson, null, 2) + '\n');
  "
  
  echo -e "${GREEN}✓ Version updated in app.json${NC}"
}

# Function to increment build numbers
increment_build_numbers() {
  echo "Incrementing build numbers..."
  
  # Get current build numbers
  IOS_BUILD=$(node -e "console.log(require('./app.json').expo.ios.buildNumber)")
  ANDROID_BUILD=$(node -e "console.log(require('./app.json').expo.android.versionCode)")
  
  # Increment
  NEW_IOS_BUILD=$((IOS_BUILD + 1))
  NEW_ANDROID_BUILD=$((ANDROID_BUILD + 1))
  
  # Update app.json
  node -e "
    const fs = require('fs');
    const appJson = JSON.parse(fs.readFileSync('app.json', 'utf8'));
    appJson.expo.ios.buildNumber = '$NEW_IOS_BUILD';
    appJson.expo.android.versionCode = $NEW_ANDROID_BUILD;
    fs.writeFileSync('app.json', JSON.stringify(appJson, null, 2) + '\n');
  "
  
  echo -e "${GREEN}✓ iOS build number: $IOS_BUILD → $NEW_IOS_BUILD${NC}"
  echo -e "${GREEN}✓ Android version code: $ANDROID_BUILD → $NEW_ANDROID_BUILD${NC}"
}

# Function to verify credentials
verify_credentials() {
  local platform=$1
  echo "Verifying $platform credentials..."
  
  if eas credentials --platform $platform &> /dev/null; then
    echo -e "${GREEN}✓ $platform credentials configured${NC}"
    return 0
  else
    echo -e "${RED}❌ $platform credentials not configured${NC}"
    echo "Please run: eas credentials --platform $platform"
    return 1
  fi
}

# Function to build iOS
build_ios() {
  echo ""
  echo "======================================"
  echo "Building iOS Production App"
  echo "======================================"
  echo ""
  
  # Verify credentials
  if ! verify_credentials "ios"; then
    return 1
  fi
  
  echo "Starting iOS build..."
  echo "This will take approximately 15-20 minutes"
  echo ""
  
  # Build
  eas build --platform ios --profile production
  
  if [ $? -eq 0 ]; then
    echo ""
    echo -e "${GREEN}✓ iOS build completed successfully${NC}"
    echo ""
    echo "Next steps:"
    echo "1. Download the .ipa file: eas build:download --platform ios --latest"
    echo "2. Test on physical device"
    echo "3. Submit to App Store: eas submit --platform ios --latest"
    return 0
  else
    echo -e "${RED}❌ iOS build failed${NC}"
    echo "Check build logs for details"
    return 1
  fi
}

# Function to build Android
build_android() {
  echo ""
  echo "======================================"
  echo "Building Android Production App"
  echo "======================================"
  echo ""
  
  # Verify credentials
  if ! verify_credentials "android"; then
    return 1
  fi
  
  echo "Starting Android build..."
  echo "This will take approximately 10-15 minutes"
  echo ""
  
  # Build
  eas build --platform android --profile production
  
  if [ $? -eq 0 ]; then
    echo ""
    echo -e "${GREEN}✓ Android build completed successfully${NC}"
    echo ""
    echo "Next steps:"
    echo "1. Download the .aab file: eas build:download --platform android --latest"
    echo "2. Test on physical device"
    echo "3. Submit to Google Play: eas submit --platform android --latest"
    return 0
  else
    echo -e "${RED}❌ Android build failed${NC}"
    echo "Check build logs for details"
    return 1
  fi
}

# Function to create changelog
create_changelog() {
  echo ""
  echo "Creating changelog for version $VERSION..."
  
  CHANGELOG_FILE="changelogs/CHANGELOG_${VERSION//./_}.md"
  mkdir -p changelogs
  
  cat > "$CHANGELOG_FILE" << EOF
# Version $VERSION

**Release Date:** $(date +"%Y-%m-%d")

## What's New

### Features
- 

### Improvements
- 

### Bug Fixes
- 

### Technical
- 

## Known Issues

- 

## Upgrade Notes

- 

---

**Build Information:**
- iOS Build: $(node -e "console.log(require('./app.json').expo.ios.buildNumber)")
- Android Build: $(node -e "console.log(require('./app.json').expo.android.versionCode)")
- Build Date: $(date +"%Y-%m-%d %H:%M:%S")
EOF

  echo -e "${GREEN}✓ Changelog created: $CHANGELOG_FILE${NC}"
  echo "Please edit the changelog with release notes"
}

# Function to create git tag
create_git_tag() {
  echo ""
  echo "Creating git tag for version $VERSION..."
  
  if git rev-parse "v$VERSION" >/dev/null 2>&1; then
    echo -e "${YELLOW}⚠ Tag v$VERSION already exists${NC}"
    read -p "Do you want to delete and recreate it? (y/n) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
      git tag -d "v$VERSION"
      git push origin --delete "v$VERSION" 2>/dev/null || true
    else
      return 0
    fi
  fi
  
  git tag -a "v$VERSION" -m "Release version $VERSION"
  echo -e "${GREEN}✓ Git tag created: v$VERSION${NC}"
  echo "Push tag with: git push origin v$VERSION"
}

# Pre-build checks
echo "Running pre-build checks..."
echo ""

# Check if package.json exists
if [ ! -f "package.json" ]; then
  echo -e "${RED}❌ package.json not found${NC}"
  echo "Please run this script from the mobile directory"
  exit 1
fi

# Check if app.json exists
if [ ! -f "app.json" ]; then
  echo -e "${RED}❌ app.json not found${NC}"
  exit 1
fi

# Check if eas.json exists
if [ ! -f "eas.json" ]; then
  echo -e "${RED}❌ eas.json not found${NC}"
  exit 1
fi

echo -e "${GREEN}✓ All configuration files found${NC}"
echo ""

# Confirm build
echo -e "${YELLOW}You are about to build version $VERSION for $PLATFORM${NC}"
read -p "Continue? (y/n) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  echo "Build cancelled"
  exit 0
fi

# Update version
update_version

# Increment build numbers
increment_build_numbers

# Create changelog
create_changelog

# Build based on platform
case $PLATFORM in
  ios)
    build_ios
    BUILD_SUCCESS=$?
    ;;
  android)
    build_android
    BUILD_SUCCESS=$?
    ;;
  both)
    build_ios
    IOS_SUCCESS=$?
    
    build_android
    ANDROID_SUCCESS=$?
    
    if [ $IOS_SUCCESS -eq 0 ] && [ $ANDROID_SUCCESS -eq 0 ]; then
      BUILD_SUCCESS=0
    else
      BUILD_SUCCESS=1
    fi
    ;;
  *)
    echo -e "${RED}Invalid platform: $PLATFORM${NC}"
    echo "Usage: ./build-production.sh [ios|android|both] [version]"
    exit 1
    ;;
esac

# Create git tag if build successful
if [ $BUILD_SUCCESS -eq 0 ]; then
  create_git_tag
fi

echo ""
echo "======================================"
echo "Build Process Complete!"
echo "======================================"
echo ""

if [ $BUILD_SUCCESS -eq 0 ]; then
  echo -e "${GREEN}✓ All builds completed successfully${NC}"
  echo ""
  echo "Next steps:"
  echo "1. Edit changelog: changelogs/CHANGELOG_${VERSION//./_}.md"
  echo "2. Download builds: eas build:download --latest"
  echo "3. Test on physical devices"
  echo "4. Submit to stores: eas submit --platform [ios|android] --latest"
  echo "5. Push git tag: git push origin v$VERSION"
  echo "6. Create GitHub release"
else
  echo -e "${RED}❌ Build failed${NC}"
  echo "Please check the error messages above and try again"
  exit 1
fi

echo ""
