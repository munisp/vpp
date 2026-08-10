#!/bin/bash

# VPP Platform - Secrets Management Setup Script
# Version: v21.0
# This script helps set up secrets management with AWS Secrets Manager or HashiCorp Vault

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo "========================================="
echo "VPP Platform Secrets Management Setup"
echo "========================================="
echo ""

# Function to print status
print_status() {
    if [ $1 -eq 0 ]; then
        echo -e "${GREEN}✓ DONE${NC} - $2"
    else
        echo -e "${RED}✗ FAIL${NC} - $2"
    fi
}

print_warning() {
    echo -e "${YELLOW}⚠ WARNING${NC} - $1"
}

print_info() {
    echo -e "${BLUE}ℹ INFO${NC} - $1"
}

# Ask user to choose secrets management solution
echo "Choose secrets management solution:"
echo "1) AWS Secrets Manager"
echo "2) HashiCorp Vault"
echo "3) Encrypted .env files (dotenv-vault)"
echo ""
read -p "Enter choice (1-3): " choice

case $choice in
    1)
        echo ""
        echo "Setting up AWS Secrets Manager..."
        echo "=================================="
        echo ""
        
        # Check if AWS CLI is installed
        if ! command -v aws &> /dev/null; then
            print_warning "AWS CLI not installed. Installing..."
            curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip"
            unzip -q awscliv2.zip
            sudo ./aws/install
            rm -rf aws awscliv2.zip
            print_status $? "AWS CLI installed"
        else
            print_info "AWS CLI already installed"
        fi
        
        # Configure AWS credentials
        echo ""
        print_info "Configure AWS credentials (if not already done)"
        read -p "AWS Access Key ID: " aws_access_key
        read -p "AWS Secret Access Key: " aws_secret_key
        read -p "AWS Region (default: us-east-1): " aws_region
        aws_region=${aws_region:-us-east-1}
        
        aws configure set aws_access_key_id "$aws_access_key"
        aws configure set aws_secret_access_key "$aws_secret_key"
        aws configure set region "$aws_region"
        print_status $? "AWS credentials configured"
        
        # Create secrets in AWS Secrets Manager
        echo ""
        print_info "Creating secrets in AWS Secrets Manager..."
        
        # Read current .env file
        if [ -f ".env" ]; then
            secret_string=$(cat .env | jq -Rs .)
            aws secretsmanager create-secret \
                --name "vpp-platform/production" \
                --description "VPP Platform production secrets" \
                --secret-string "$secret_string" \
                --region "$aws_region" 2>/dev/null || \
            aws secretsmanager update-secret \
                --secret-id "vpp-platform/production" \
                --secret-string "$secret_string" \
                --region "$aws_region"
            print_status $? "Secrets stored in AWS Secrets Manager"
        else
            print_warning "No .env file found to upload"
        fi
        
        # Create script to fetch secrets
        cat > scripts/fetch-secrets-aws.sh << 'EOFAWS'
#!/bin/bash
# Fetch secrets from AWS Secrets Manager

REGION="${AWS_REGION:-us-east-1}"
SECRET_NAME="vpp-platform/production"

echo "Fetching secrets from AWS Secrets Manager..."
aws secretsmanager get-secret-value \
    --secret-id "$SECRET_NAME" \
    --region "$REGION" \
    --query SecretString \
    --output text > .env

echo "Secrets fetched and saved to .env"
EOFAWS
        chmod +x scripts/fetch-secrets-aws.sh
        
        echo ""
        print_info "AWS Secrets Manager setup complete!"
        print_info "To fetch secrets: ./scripts/fetch-secrets-aws.sh"
        ;;
        
    2)
        echo ""
        echo "Setting up HashiCorp Vault..."
        echo "=============================="
        echo ""
        
        # Check if Vault is installed
        if ! command -v vault &> /dev/null; then
            print_warning "Vault not installed. Installing..."
            wget -qO- https://apt.releases.hashicorp.com/gpg | sudo gpg --dearmor -o /usr/share/keyrings/hashicorp-archive-keyring.gpg
            echo "deb [signed-by=/usr/share/keyrings/hashicorp-archive-keyring.gpg] https://apt.releases.hashicorp.com $(lsb_release -cs) main" | sudo tee /etc/apt/sources.list.d/hashicorp.list
            sudo apt-get update -qq && sudo apt-get install -y -qq vault
            print_status $? "Vault installed"
        else
            print_info "Vault already installed"
        fi
        
        # Configure Vault
        echo ""
        read -p "Vault server address (default: http://127.0.0.1:8200): " vault_addr
        vault_addr=${vault_addr:-http://127.0.0.1:8200}
        read -p "Vault token: " vault_token
        
        export VAULT_ADDR="$vault_addr"
        export VAULT_TOKEN="$vault_token"
        
        # Store secrets in Vault
        echo ""
        print_info "Storing secrets in Vault..."
        
        if [ -f ".env" ]; then
            while IFS='=' read -r key value; do
                # Skip comments and empty lines
                [[ "$key" =~ ^#.*$ ]] && continue
                [[ -z "$key" ]] && continue
                
                vault kv put secret/vpp-platform/"$key" value="$value" 2>/dev/null
            done < .env
            print_status $? "Secrets stored in Vault"
        else
            print_warning "No .env file found to upload"
        fi
        
        # Create script to fetch secrets
        cat > scripts/fetch-secrets-vault.sh << 'EOFVAULT'
#!/bin/bash
# Fetch secrets from HashiCorp Vault

VAULT_ADDR="${VAULT_ADDR:-http://127.0.0.1:8200}"
VAULT_TOKEN="${VAULT_TOKEN}"

if [ -z "$VAULT_TOKEN" ]; then
    echo "Error: VAULT_TOKEN not set"
    exit 1
fi

echo "Fetching secrets from Vault..."
> .env

# List all secrets
vault kv list -format=json secret/vpp-platform | jq -r '.[]' | while read -r key; do
    value=$(vault kv get -field=value secret/vpp-platform/"$key")
    echo "$key=$value" >> .env
done

echo "Secrets fetched and saved to .env"
EOFVAULT
        chmod +x scripts/fetch-secrets-vault.sh
        
        echo ""
        print_info "HashiCorp Vault setup complete!"
        print_info "To fetch secrets: VAULT_TOKEN=<token> ./scripts/fetch-secrets-vault.sh"
        ;;
        
    3)
        echo ""
        echo "Setting up dotenv-vault..."
        echo "=========================="
        echo ""
        
        # Install dotenv-vault
        if ! command -v dotenv-vault &> /dev/null; then
            print_info "Installing dotenv-vault..."
            npm install -g dotenv-vault
            print_status $? "dotenv-vault installed"
        else
            print_info "dotenv-vault already installed"
        fi
        
        # Initialize dotenv-vault
        echo ""
        print_info "Initializing dotenv-vault..."
        
        if [ ! -f ".env.vault" ]; then
            dotenv-vault new
            print_status $? "dotenv-vault initialized"
        else
            print_info "dotenv-vault already initialized"
        fi
        
        # Push secrets
        echo ""
        print_info "Pushing secrets to dotenv-vault..."
        dotenv-vault push
        print_status $? "Secrets pushed to dotenv-vault"
        
        # Get decryption key
        echo ""
        print_info "Getting decryption key..."
        dotenv-vault keys production
        
        echo ""
        print_info "dotenv-vault setup complete!"
        print_info "To pull secrets: dotenv-vault pull"
        print_info "To decrypt: DOTENV_KEY=<key> node your-app.js"
        ;;
        
    *)
        print_warning "Invalid choice. Exiting."
        exit 1
        ;;
esac

echo ""
echo "========================================="
echo "Secrets Management Setup Complete"
echo "========================================="
echo ""
echo "Security Recommendations:"
echo "1. Never commit .env files to version control"
echo "2. Rotate secrets regularly (every 90 days)"
echo "3. Use different secrets for each environment"
echo "4. Limit access to secrets management systems"
echo "5. Enable audit logging for secret access"
echo "6. Set up alerts for unauthorized access attempts"
echo ""
echo "========================================="
