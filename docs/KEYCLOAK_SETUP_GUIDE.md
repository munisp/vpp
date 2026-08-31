# Keycloak Setup Guide for VPP Platform

## Overview

This guide provides step-by-step instructions for setting up Keycloak authentication for the VPP Consumer Platform.

## Prerequisites

- Keycloak server running (NextGen VPP Platform or standalone)
- Admin access to Keycloak console
- VPP Consumer Platform deployed

## Step 1: Access Keycloak Admin Console

**URL:** http://localhost:8080

**Default Credentials:**
- Username: `admin`
- Password: `admin` (change in production!)

## Step 2: Create Realm

1. **Navigate to Realm dropdown** (top-left corner)
2. **Click "Create Realm"**
3. **Configure realm:**
   - **Realm name:** `vpp-platform`
   - **Enabled:** ON
   - **Display name:** `VPP Platform`
   - **HTML Display name:** `<b>VPP</b> Platform`
4. **Click "Create"**

## Step 3: Configure Realm Settings

### General Settings

Navigate to **Realm Settings** → **General**:

- **User Profile Enabled:** ON
- **Email as username:** OFF (allow separate usernames)
- **Login with email:** ON
- **Duplicate emails:** OFF
- **Verify email:** ON (recommended for production)
- **Reset password:** ON

### Login Settings

Navigate to **Realm Settings** → **Login**:

- **User registration:** ON (if you want self-registration)
- **Forgot password:** ON
- **Remember me:** ON
- **Email as username:** OFF
- **Login with email:** ON

### Email Settings (Production)

Navigate to **Realm Settings** → **Email**:

```
Host: smtp.example.com
Port: 587
From: noreply@vpp-platform.com
Enable StartTLS: ON
Enable Authentication: ON
Username: smtp-user
Password: smtp-password
```

Test email configuration with "Test connection" button.

### Tokens Settings

Navigate to **Realm Settings** → **Tokens**:

- **Access Token Lifespan:** 5 minutes
- **Access Token Lifespan For Implicit Flow:** 15 minutes
- **Client login timeout:** 5 minutes
- **Login timeout:** 30 minutes
- **Login action timeout:** 5 minutes
- **Refresh Token Max Reuse:** 0 (one-time use)
- **SSO Session Idle:** 30 minutes
- **SSO Session Max:** 10 hours

## Step 4: Create Client

1. **Navigate to Clients** (left sidebar)
2. **Click "Create client"**
3. **General Settings:**
   - **Client type:** OpenID Connect
   - **Client ID:** `vpp-consumer-platform`
   - **Name:** `VPP Consumer Platform`
   - **Description:** `Consumer-facing web and mobile application`
   - **Always display in console:** OFF
4. **Click "Next"**

5. **Capability config:**
   - **Client authentication:** ON (confidential client)
   - **Authorization:** OFF
   - **Authentication flow:**
     - ✅ Standard flow (Authorization Code)
     - ✅ Direct access grants (Resource Owner Password)
     - ✅ Service accounts roles (for backend)
     - ❌ Implicit flow (deprecated)
     - ❌ OAuth 2.0 Device Authorization Grant
6. **Click "Next"**

7. **Login settings:**
   - **Root URL:** `http://localhost:3000`
   - **Home URL:** `http://localhost:3000`
   - **Valid redirect URIs:**
     - `http://localhost:3000/*`
     - `https://your-domain.com/*` (production)
   - **Valid post logout redirect URIs:**
     - `http://localhost:3000`
     - `https://your-domain.com` (production)
   - **Web origins:**
     - `http://localhost:3000`
     - `https://your-domain.com` (production)
8. **Click "Save"**

## Step 5: Get Client Secret

1. **Navigate to Clients** → `vpp-consumer-platform`
2. **Click "Credentials" tab**
3. **Copy the Client Secret**
4. **Save to environment variables:**

```bash
KEYCLOAK_CLIENT_SECRET=<paste-secret-here>
```

## Step 6: Create Roles

1. **Navigate to Realm Roles** (left sidebar)
2. **Click "Create role"**

### Create "admin" Role

- **Role name:** `admin`
- **Description:** `Administrator with full access`
- **Click "Save"**

### Create "user" Role

- **Role name:** `user`
- **Description:** `Regular user with standard access`
- **Click "Save"**

### Create "operator" Role (Optional)

- **Role name:** `operator`
- **Description:** `VPP operator with monitoring access`
- **Click "Save"**

## Step 7: Create Users

### Create Admin User

1. **Navigate to Users** (left sidebar)
2. **Click "Create new user"**
3. **Configure user:**
   - **Username:** `admin`
   - **Email:** `admin@vpp-platform.com`
   - **Email verified:** ON
   - **First name:** `Admin`
   - **Last name:** `User`
   - **Enabled:** ON
4. **Click "Create"**

5. **Set Password:**
   - Click "Credentials" tab
   - Click "Set password"
   - **Password:** Choose strong password
   - **Temporary:** OFF
   - Click "Save"

6. **Assign Role:**
   - Click "Role mapping" tab
   - Click "Assign role"
   - Select "admin" role
   - Click "Assign"

### Create Test User

Repeat above steps with:
- **Username:** `testuser`
- **Email:** `test@vpp-platform.com`
- **Role:** `user`

## Step 8: Configure Client Scopes

### Add Custom Attributes

1. **Navigate to Client Scopes** (left sidebar)
2. **Click "profile"**
3. **Click "Mappers" tab**
4. **Click "Add mapper" → "By configuration"**
5. **Select "User Attribute"**

**Mapper Configuration:**
- **Name:** `vpp-user-id`
- **User Attribute:** `vppUserId`
- **Token Claim Name:** `vpp_user_id`
- **Claim JSON Type:** String
- **Add to ID token:** ON
- **Add to access token:** ON
- **Add to userinfo:** ON
- **Click "Save"**

## Step 9: Configure Environment Variables

Add to `.env` file:

```bash
# Keycloak Configuration
KEYCLOAK_SERVER_URL=http://localhost:8080
KEYCLOAK_REALM=vpp-platform
KEYCLOAK_CLIENT_ID=vpp-consumer-platform
KEYCLOAK_CLIENT_SECRET=<your-client-secret>

# Optional: TLS Configuration
KEYCLOAK_TLS_ENABLED=false
```

For production:

```bash
KEYCLOAK_SERVER_URL=https://auth.vpp-platform.com
KEYCLOAK_REALM=vpp-platform
KEYCLOAK_CLIENT_ID=vpp-consumer-platform
KEYCLOAK_CLIENT_SECRET=<production-secret>
KEYCLOAK_TLS_ENABLED=true
```

## Step 10: Test Integration

### Test with Keycloak Client

```typescript
import { keycloakClient } from './server/integration/keycloak-auth';

// Test health check
const health = await keycloakClient.healthCheck();
console.log('Keycloak Health:', health);
// Expected: { connected: true, realm: 'vpp-platform' }

// Test authentication
const token = await keycloakClient.authenticateUser('testuser', 'password');
console.log('Access Token:', token.access_token);

// Test token validation
const isValid = await keycloakClient.validateToken(token.access_token);
console.log('Token Valid:', isValid);
// Expected: true

// Get user info
const userInfo = await keycloakClient.getUserInfo(token.access_token);
console.log('User Info:', userInfo);
```

### Test with cURL

**Get Access Token:**

```bash
curl -X POST http://localhost:8080/realms/vpp-platform/protocol/openid-connect/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=password" \
  -d "client_id=vpp-consumer-platform" \
  -d "client_secret=<your-client-secret>" \
  -d "username=testuser" \
  -d "password=password"
```

**Validate Token:**

```bash
curl -X POST http://localhost:8080/realms/vpp-platform/protocol/openid-connect/token/introspect \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "client_id=vpp-consumer-platform" \
  -d "client_secret=<your-client-secret>" \
  -d "token=<access-token>"
```

**Get User Info:**

```bash
curl http://localhost:8080/realms/vpp-platform/protocol/openid-connect/userinfo \
  -H "Authorization: Bearer <access-token>"
```

## Step 11: Integrate with VPP Platform

### Option 1: Replace Manus OAuth (Full Integration)

Update `server/_core/auth.ts` to use Keycloak instead of Manus OAuth:

```typescript
import { keycloakClient } from '../integration/keycloak-auth';

// Replace Manus OAuth callback with Keycloak
router.get('/oauth/callback', async (req, res) => {
  const { code } = req.query;
  
  // Exchange code for token with Keycloak
  // Validate token
  // Create session
  // Redirect to app
});
```

### Option 2: Hybrid Approach (Keep Manus OAuth)

Use Keycloak for additional features:
- Enterprise SSO
- Advanced role management
- Multi-factor authentication
- User federation (LDAP, Active Directory)

```typescript
// Keep Manus OAuth for primary authentication
// Use Keycloak for enterprise customers
if (req.headers['x-enterprise-sso'] === 'true') {
  // Use Keycloak authentication
} else {
  // Use Manus OAuth
}
```

## Advanced Configuration

### Enable Multi-Factor Authentication (MFA)

1. **Navigate to Authentication** (left sidebar)
2. **Click "Required actions"**
3. **Enable "Configure OTP"**
4. **Set as default action for new users**

### Configure User Federation

For LDAP/Active Directory integration:

1. **Navigate to User Federation** (left sidebar)
2. **Click "Add provider" → "ldap"**
3. **Configure LDAP settings:**
   - Connection URL
   - Bind DN
   - Bind credentials
   - User DN
   - Search scope
4. **Test connection**
5. **Sync users**

### Enable Social Login

Add Google, Facebook, GitHub, etc.:

1. **Navigate to Identity Providers** (left sidebar)
2. **Click "Add provider"**
3. **Select provider (e.g., Google)**
4. **Configure OAuth credentials**
5. **Map attributes**
6. **Test login**

### Custom Themes

Customize login pages:

1. **Navigate to Realm Settings** → **Themes**
2. **Login theme:** Select custom theme
3. **Account theme:** Select custom theme
4. **Admin console theme:** Select custom theme

## Security Best Practices

### Production Checklist

- [ ] Change default admin password
- [ ] Enable HTTPS/TLS
- [ ] Configure email verification
- [ ] Enable password policies
- [ ] Set up MFA for admin accounts
- [ ] Configure session timeouts
- [ ] Enable brute force detection
- [ ] Set up audit logging
- [ ] Regular backup of realm configuration
- [ ] Use secrets management for client secrets

### Password Policy

Navigate to **Authentication** → **Policies** → **Password Policy**:

- **Minimum length:** 12
- **Require uppercase:** ON
- **Require lowercase:** ON
- **Require digits:** ON
- **Require special characters:** ON
- **Not username:** ON
- **Password history:** 5
- **Expire password:** 90 days

### Brute Force Detection

Navigate to **Realm Settings** → **Security Defenses** → **Brute Force Detection**:

- **Enabled:** ON
- **Max login failures:** 5
- **Wait increment:** 60 seconds
- **Quick login check:** 1000 milliseconds
- **Minimum quick login wait:** 60 seconds
- **Max wait:** 900 seconds (15 minutes)
- **Failure reset time:** 43200 seconds (12 hours)

## Monitoring

### View Events

**Navigate to Events:**
- **Login Events:** Realm Settings → Events → Login events
- **Admin Events:** Realm Settings → Events → Admin events

**Enable Event Logging:**
- Login events: ON
- Admin events: ON
- Save events: ON
- Event listeners: Add "jboss-logging"

### Export Realm Configuration

**Backup realm settings:**

1. **Navigate to Realm Settings** → **Action** → **Partial export**
2. **Select what to export:**
   - ✅ Clients
   - ✅ Roles
   - ✅ Groups
   - ❌ Users (export separately if needed)
3. **Click "Export"**
4. **Save JSON file**

**Restore from backup:**

1. **Navigate to Realm Settings** → **Action** → **Partial import**
2. **Upload JSON file**
3. **Select import strategy**
4. **Click "Import"**

## Troubleshooting

### Cannot Connect to Keycloak

**Check Keycloak server:**

```bash
# Test connection
curl http://localhost:8080/realms/vpp-platform

# Check Docker container
docker ps | grep keycloak
docker logs nextgen_keycloak
```

### Authentication Fails

**Check credentials:**
- Verify username/password
- Check user is enabled
- Verify email is verified (if required)

**Check client configuration:**
- Verify client ID
- Verify client secret
- Check redirect URIs

### Token Validation Fails

**Check token expiry:**
- Access tokens expire after 5 minutes by default
- Use refresh token to get new access token

**Check token format:**
- Ensure Bearer prefix: `Authorization: Bearer <token>`

### Users Cannot Login

**Check user status:**
- Navigate to Users → Select user
- Verify "Enabled" is ON
- Check "Email verified" if required
- Verify password is set

**Check role assignments:**
- Navigate to Users → Select user → Role mapping
- Verify required roles are assigned

## Support

For issues or questions:
- **Keycloak Admin Console**: http://localhost:8080
- **Keycloak Documentation**: https://www.keycloak.org/documentation
- **Integration Guide**: `docs/MIDDLEWARE_DEPLOYMENT_GUIDE.md`
- **Client Implementation**: ~~`server/integration/keycloak-client.ts`~~ (removed — dead code; auth is `server/integration/keycloak-auth.ts`)
