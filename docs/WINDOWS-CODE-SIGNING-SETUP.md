# Windows Code Signing Setup — When Ready

This document provides step-by-step instructions for configuring Windows code signing for VupsRouter releases. **Current status: unsigned builds only**. Do not configure until you are ready to procure a certificate.

## Option A: Azure Artifact Signing (Public Trust)

**Eligibility**: Requires Microsoft enrollment as a verified publisher. India is NOT supported as of current requirements. Check your country eligibility at Microsoft's Public Trust portal.

### Prerequisites
- Microsoft Azure subscription
- Verified publisher identity (OV certificate issued by CA after business validation)
- GitHub repository with write access to Actions

### Setup Steps

1. **Create Signing Account**
   - Navigate to Azure Portal → Search "Artifact Signer" → Create new resource
   - Select region where you want signing account created
   - Choose "Enterprise Trusted Signing" or "Public Trust" based on your organization type

2. **Configure Region**
   - After creation, go to Overview tab
   - Note the **Account Name** (e.g., `vupsrouter-signing`)
   - Note the **Endpoint URL** (region-specific, e.g., `https://eastus.codesigning.azure.net/`)

3. **Create App Registration**
   - Navigate to Azure Active Directory → App registrations → New registration
   - Name: `vupsrouter-github-signing`
   - Supported account types: Single tenant
   - Redirect URI: Leave blank (OIDC federation doesn't use this)

4. **Configure OIDC Federation**
   - Go to Certificates & secrets → + New federated credential
   - Select "GitHub Actions" under Application type
   - Organization: `CrazyVillainFF`
   - Repository: `Vups-Router`
   - Workload identity version: v1
   - Name: `vupsrouter-github-signing`
   - Click Create

5. **Grant Permission to Signing Account**
   - Navigate back to your signing account (`vupsrouter-signing`)
   - Go to Permissions → Add assignment
   - Select the app registration you just created
   - Grant permission to sign artifacts

6. **Create Certificate Profile**
   - Go to Certificate profiles → + New profile
   - Name: `VupsRouter-OV`
   - Select "Code Signing" certificate type
   - Choose OV (Organization Validation) for maximum SmartScreen trust
   - Configure signature algorithm: SHA-256
   - Save profile

7. **Test Connection**
   - Go to Settings → Test connection
   - Verify Azure can reach your signing account
   - Confirm no errors appear

8. **Add GitHub Secrets**
   Navigate to repository → Settings → Secrets and variables → Actions → New repository secret:

| Secret Name | Value Source | Example |
|-------------|--------------|---------|
| `AZURE_TRUSTED_CERT_TENANT_ID` | Azure AD → Overview → Tenant ID | `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` |
| `AZURE_TRUSTED_CERT_CLIENT_ID` | App registrations → Your app → Application ID | `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` |
| `AZURE_TRUSTED_CERT_SUBSCRIPTION_ID` | Subscription → Overview → Subscription ID | `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` |

9. **Add GitHub Variables**
   Same location → New repository variable:

| Variable Name | Value | Example |
|---------------|-------|---------|
| `AZURE_TRUSTED_CERT_ACCOUNT` | Signing account name from step 2 | `vupsrouter-signing` |
| `AZURE_TRUSTED_CERT_PROFILE` | Certificate profile name from step 7 | `VupsRouter-OV` |
| `AZURE_TRUSTED_CERT_ENDPOINT` | Optional; defaults to East US | `https://eastus.codesigning.azure.net/` |

10. **Test Build**
    - Trigger a manual workflow run: Actions → Native builds → Run workflow
    - Fill in tag manually (e.g., `v2.1.1`)
    - Check output logs for `windows-signing-available` job
    - Should report: "Azure Artifact Signing is configured: the installers will be signed"

## Option B: Classic Authenticode PFX Certificate

**Recommended for most users**: Obtain an OV/EV code signing certificate from any trusted CA (DigiCert, Sectigo, GlobalSign, Comodo, etc.).

### Prerequisites
- Budget for OV/EV certificate purchase (~$200-500/year)
- Business verification materials (company registration documents, GST certificate, etc.)
- Private key export capability

### Setup Steps

1. **Purchase Certificate**
   - Visit any major CA's website (DigiCert, Sectigo, GlobalSign, Comodo)
   - Order "Organization Validation (OV) Code Signing Certificate"
   - Complete business verification process
   - Wait 2-5 business days for verification

2. **Generate CSR and Install Certificate**
   - CA will guide you through CSR generation
   - Install certificate on a secure Windows machine
   - Ensure private key is marked as "exportable"

3. **Export to PFX**
   - Open `certmgr.msc` (Certificate Manager)
   - Locate certificate under "Personal → Certificates"
   - Right-click → All Tasks → Export
   - Select "Yes, export the private key"
   - Format: PKCS #12 (.pfx)
   - Uncheck "Include all certificates" unless required
   - Set strong password (store it securely)
   - Save `.pfx` file

4. **Convert to Base64**
   ```powershell
   $pfxBytes = [System.IO.File]::ReadAllBytes("C:\path\to\vupsrouter.pfx")
   $base64 = [Convert]::ToBase64String($pfxBytes)
   # Copy the entire base64 string (may span multiple lines)
   ```

5. **Add GitHub Secrets**
   Navigate to repository → Settings → Secrets and variables → Actions → New repository secret:

| Secret Name | Value Source | Example |
|-------------|--------------|---------|
| `WINDOWS_CERT_PFX_BASE64` | Base64-encoded .pfx content from step 4 | Long base64 string (hundreds/thousands of characters) |
| `WINDOWS_CERT_PASSWORD` | Password used during PFX export | Strong password (store separately) |

6. **(Optional) Configure Timestamp Server**
   Default is Microsoft's RFC3161 timestamp server. To override:

| Variable Name | Value | Example |
|---------------|-------|---------|
| `WINDOWS_CERT_TIMESTAMP_URL` | RFC3161 timestamp server URL | `http://timestamp.acs.microsoft.com` |

7. **Test Build**
   - Trigger a manual workflow run: Actions → Native builds → Run workflow
   - Fill in tag manually (e.g., `v2.1.1`)
   - Check output logs for `windows-signing-available` job
   - Should report: "An Authenticode PFX is configured: the installers will be signed"

## Verification Steps (Both Options)

After configuration, verify the signing pipeline:

1. **Check Job Output**
   ```bash
   Actions → Native Builds → Recent Run → windows-signing-available job
   ```
   
   Expected outputs:
   - `mode=azure-trusted` OR `mode=pfx` (depending on configuration)
   - Step summary: "X will be signed"
   - No `mode=none` messages

2. **Build and Inspect**
   ```powershell
   npm ci
   npm run build
   npm run tauri:build
   ```
   
   The build produces:
   - `src-tauri/target/release/bundle/nsis/*.exe` (NSIS installer)
   - `src-tauri/target/release/bundle/msi/*.msi` (MSI bundle)

3. **Verify Signature Locally**
   ```powershell
   cd src-tauri/target/release/bundle/nsis
   signtool verify /pa /v VupsRouter-windows-x64-setup.exe
   ```
   
   Expected: `Installer: signature valid`

4. **Check Publisher Identity**
   ```powershell
   Get-AuthenticodeSignature VupsRouter-windows-x64-setup.exe
   ```
   
   Expected:
   - `Status: Valid`
   - `SignerCertificate.Subject` contains your company name or verified publisher info

## IMPORTANT NOTES

### SmartScreen Reputation
Even with valid signing:
- Brand-new certificates show SmartScreen warnings for 1-4 weeks
- Reputation accumulates through download volume and user acceptance
- EV certificates gain reputation faster than OV
- Public Trust Azure signing starts with zero reputation

### File Size Requirements
The CI/CD rejects artifacts smaller than **1 MB** to prevent:
- Empty files being published
- HTML error pages replacing installers
- Truncated uploads

### Checksum Integrity
Every released asset gets SHA-256 checksums generated AFTER final signing. Users should verify:
```bash
Get-FileHash VupsRouter-windows-x64-setup.exe -Algorithm SHA256
```
Against `SHA256SUMS.txt` in release notes.

### Updater Minisign Chain
Tauri updater uses minisign, which is **separate** from Authenticode:
- Authenticode removes SmartScreen warning
- Minisign lets installed app verify update integrity
- Both are independent signing identities
- Minisign signs installer bytes AFTER Authenticode rewrites them

### WINDOWS_SIGNING_REQUIRED Variable
Repository variable controls behavior:

| Setting | Behavior |
|---------|----------|
| **Not set** (default) | Unsigned builds proceed with honest announcement |
| `true` | CI/CD fails if no credentials found; prevents unsigned releases |
| `false` | Same as not set |

**Recommendation**: Keep unset until signing is proven working. Then set to `true` once you have operational signing.

## When NOT to Configure

Do NOT add placeholder credentials if:
- You're still evaluating signing providers
- You don't have budget allocated
- You haven't completed business verification
- You're testing local-only builds

Fake credentials break the signing chain and cause confusing failures.

## Next Steps After Configuration

Once credentials are active:

1. **Run test build** without publishing
2. **Download produced installer**
3. **Install on clean VM** (Windows Sandbox or fresh environment)
4. **Verify SmartScreen behavior** (should show publisher name)
5. **Check file properties** → Digital Signatures tab
6. **Review release notes** explicitly state installation steps
7. **Set `WINDOWS_SIGNING_REQUIRED=true`** to prevent future unsigned releases

## Current Production Status

As of 2026-11-09:
- Windows installers remain unsigned
- `windows-signing-available` reports `mode=none`
- `TAURI_SIGNING_PRIVATE_KEY` is not configured (updater disabled)
- Release notes include explicit "unsigned" disclaimer
- Users see "Windows protected your PC" prompt on first run
- This is intentional and documented behavior

Continue monitoring Microsoft's Public Trust eligibility for Indian organizations. Consider cost-sharing certificate purchase among users if organizational budget unavailable.
