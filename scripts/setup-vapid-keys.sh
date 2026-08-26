#!/bin/bash

# VPP Platform - VAPID Keys Setup Script
# This script helps you configure VAPID keys for push notifications

set -e

echo "================================================"
echo "VPP Platform - VAPID Keys Setup"
echo "================================================"
echo ""

# Check if .env file exists
if [ ! -f .env ]; then
    echo "Creating .env file..."
    touch .env
fi

# Check if VAPID keys are already configured
if grep -q "VAPID_PUBLIC_KEY" .env && grep -q "VAPID_PRIVATE_KEY" .env; then
    echo "⚠️  VAPID keys are already configured in .env file"
    echo ""
    read -p "Do you want to regenerate keys? (y/N): " -n 1 -r
    echo ""
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "Keeping existing keys. Exiting."
        exit 0
    fi
fi

echo "Generating new VAPID keys..."
echo ""

# Generate VAPID keys
VAPID_OUTPUT=$(npx web-push generate-vapid-keys 2>&1)

# Extract public and private keys
PUBLIC_KEY=$(echo "$VAPID_OUTPUT" | grep "Public Key:" -A 1 | tail -n 1 | tr -d '[:space:]')
PRIVATE_KEY=$(echo "$VAPID_OUTPUT" | grep "Private Key:" -A 1 | tail -n 1 | tr -d '[:space:]')

if [ -z "$PUBLIC_KEY" ] || [ -z "$PRIVATE_KEY" ]; then
    echo "❌ Failed to generate VAPID keys"
    exit 1
fi

echo "✅ VAPID keys generated successfully"
echo ""
echo "Public Key:  $PUBLIC_KEY"
echo "Private Key: $PRIVATE_KEY"
echo ""

# Get VAPID subject
echo "Enter VAPID subject (mailto:your-email@domain.com or https://yourdomain.com):"
read -p "Subject: " VAPID_SUBJECT

if [ -z "$VAPID_SUBJECT" ]; then
    VAPID_SUBJECT="mailto:admin@vpp-platform.com"
    echo "Using default subject: $VAPID_SUBJECT"
fi

# Remove old VAPID keys from .env
sed -i '/VAPID_PUBLIC_KEY/d' .env
sed -i '/VAPID_PRIVATE_KEY/d' .env
sed -i '/VAPID_SUBJECT/d' .env
sed -i '/VITE_VAPID_PUBLIC_KEY/d' .env

# Add new VAPID keys to .env
echo "" >> .env
echo "# VAPID Keys for Push Notifications" >> .env
echo "VAPID_PUBLIC_KEY=$PUBLIC_KEY" >> .env
echo "VAPID_PRIVATE_KEY=$PRIVATE_KEY" >> .env
echo "VAPID_SUBJECT=$VAPID_SUBJECT" >> .env
echo "VITE_VAPID_PUBLIC_KEY=$PUBLIC_KEY" >> .env

echo ""
echo "✅ VAPID keys added to .env file"
echo ""
echo "================================================"
echo "Next Steps:"
echo "================================================"
echo ""
echo "1. Restart your development server:"
echo "   pnpm dev"
echo ""
echo "2. For production deployment, add these secrets to the deployment secrets manager:"
echo "   - Go to Settings → Secrets"
echo "   - Add VAPID_PUBLIC_KEY: $PUBLIC_KEY"
echo "   - Add VAPID_PRIVATE_KEY: $PRIVATE_KEY"
echo "   - Add VAPID_SUBJECT: $VAPID_SUBJECT"
echo "   - Add VITE_VAPID_PUBLIC_KEY: $PUBLIC_KEY"
echo ""
echo "3. Test push notifications:"
echo "   - Navigate to /notifications"
echo "   - Enable push notifications"
echo "   - Click 'Send Test Notification'"
echo ""
echo "⚠️  SECURITY WARNING:"
echo "   - Never commit .env file to version control"
echo "   - Keep VAPID_PRIVATE_KEY secret"
echo "   - Generate new keys for production"
echo ""
echo "================================================"
