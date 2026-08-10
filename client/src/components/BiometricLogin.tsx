import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Fingerprint, Loader2, AlertCircle } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { toast } from "sonner";

interface BiometricLoginProps {
  onSuccess?: () => void;
  onError?: (error: string) => void;
}

export function BiometricLogin({ onSuccess, onError }: BiometricLoginProps) {
  const [isSupported, setIsSupported] = useState(false);
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Check if WebAuthn is supported
    if (window.PublicKeyCredential) {
      setIsSupported(true);
    }
  }, []);

  const handleBiometricLogin = async () => {
    setIsAuthenticating(true);
    setError(null);

    try {
      // Check if platform authenticator is available
      const available = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
      
      if (!available) {
        throw new Error("Biometric authentication not available on this device");
      }

      // In a real implementation, you would:
      // 1. Request challenge from server
      // 2. Call navigator.credentials.get() with the challenge
      // 3. Send the response to server for verification
      // 4. Handle success/failure

      // For now, we'll simulate the flow
      const challenge = new Uint8Array(32);
      window.crypto.getRandomValues(challenge);

      const publicKeyCredentialRequestOptions: PublicKeyCredentialRequestOptions = {
        challenge: challenge,
        timeout: 60000,
        userVerification: "required",
        rpId: window.location.hostname,
      };

      try {
        const credential = await navigator.credentials.get({
          publicKey: publicKeyCredentialRequestOptions,
        }) as PublicKeyCredential | null;

        if (credential) {
          // In production, send credential to server for verification
          // const response = await fetch('/api/biometric/verify', {
          //   method: 'POST',
          //   body: JSON.stringify({ credential }),
          // });

          toast.success("Biometric authentication successful!");
          onSuccess?.();
        } else {
          throw new Error("Authentication cancelled");
        }
      } catch (err) {
        if (err instanceof Error) {
          if (err.name === "NotAllowedError") {
            throw new Error("Authentication cancelled or not allowed");
          } else if (err.name === "InvalidStateError") {
            throw new Error("No biometric credentials registered");
          } else {
            throw err;
          }
        }
        throw new Error("Authentication failed");
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Biometric authentication failed";
      setError(errorMessage);
      onError?.(errorMessage);
      toast.error(errorMessage);
    } finally {
      setIsAuthenticating(false);
    }
  };

  if (!isSupported) {
    return (
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" />
        <AlertDescription>
          Biometric authentication is not supported on this device or browser.
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Fingerprint className="h-5 w-5" />
          Biometric Login
        </CardTitle>
        <CardDescription>
          Use your fingerprint or Face ID to sign in quickly and securely
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <Button
          onClick={handleBiometricLogin}
          disabled={isAuthenticating}
          className="w-full gap-2"
          size="lg"
        >
          {isAuthenticating ? (
            <>
              <Loader2 className="h-5 w-5 animate-spin" />
              Authenticating...
            </>
          ) : (
            <>
              <Fingerprint className="h-5 w-5" />
              Sign in with Biometrics
            </>
          )}
        </Button>

        <p className="text-xs text-muted-foreground text-center">
          Your biometric data never leaves your device and is not stored on our servers
        </p>
      </CardContent>
    </Card>
  );
}

export function BiometricRegistration() {
  const [isSupported, setIsSupported] = useState(false);
  const [isRegistering, setIsRegistering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [registered, setRegistered] = useState(false);

  useEffect(() => {
    if (window.PublicKeyCredential) {
      setIsSupported(true);
    }
  }, []);

  const handleRegisterBiometric = async () => {
    setIsRegistering(true);
    setError(null);

    try {
      const available = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
      
      if (!available) {
        throw new Error("Biometric authentication not available on this device");
      }

      // In a real implementation:
      // 1. Request registration options from server
      // 2. Call navigator.credentials.create()
      // 3. Send credential to server for storage

      const challenge = new Uint8Array(32);
      window.crypto.getRandomValues(challenge);

      const userId = new Uint8Array(16);
      window.crypto.getRandomValues(userId);

      const publicKeyCredentialCreationOptions: PublicKeyCredentialCreationOptions = {
        challenge: challenge,
        rp: {
          name: "VPP Platform",
          id: window.location.hostname,
        },
        user: {
          id: userId,
          name: "user@example.com", // Should come from logged-in user
          displayName: "User", // Should come from logged-in user
        },
        pubKeyCredParams: [
          { alg: -7, type: "public-key" }, // ES256
          { alg: -257, type: "public-key" }, // RS256
        ],
        authenticatorSelection: {
          authenticatorAttachment: "platform",
          requireResidentKey: false,
          userVerification: "required",
        },
        timeout: 60000,
        attestation: "none",
      };

      const credential = await navigator.credentials.create({
        publicKey: publicKeyCredentialCreationOptions,
      }) as PublicKeyCredential | null;

      if (credential) {
        // In production, send credential to server
        // await fetch('/api/biometric/register', {
        //   method: 'POST',
        //   body: JSON.stringify({ credential }),
        // });

        setRegistered(true);
        toast.success("Biometric authentication registered successfully!");
      } else {
        throw new Error("Registration cancelled");
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Registration failed";
      setError(errorMessage);
      toast.error(errorMessage);
    } finally {
      setIsRegistering(false);
    }
  };

  if (!isSupported) {
    return (
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" />
        <AlertDescription>
          Biometric authentication is not supported on this device or browser.
        </AlertDescription>
      </Alert>
    );
  }

  if (registered) {
    return (
      <Alert>
        <Fingerprint className="h-4 w-4" />
        <AlertDescription>
          Biometric authentication is now enabled for your account!
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Fingerprint className="h-5 w-5" />
          Enable Biometric Login
        </CardTitle>
        <CardDescription>
          Register your fingerprint or Face ID for quick and secure access
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <Button
          onClick={handleRegisterBiometric}
          disabled={isRegistering}
          className="w-full gap-2"
        >
          {isRegistering ? (
            <>
              <Loader2 className="h-5 w-5 animate-spin" />
              Registering...
            </>
          ) : (
            <>
              <Fingerprint className="h-5 w-5" />
              Register Biometrics
            </>
          )}
        </Button>

        <div className="text-xs text-muted-foreground space-y-2">
          <p>Benefits of biometric login:</p>
          <ul className="list-disc list-inside space-y-1 ml-2">
            <li>Faster login without typing passwords</li>
            <li>More secure than traditional passwords</li>
            <li>Your biometric data stays on your device</li>
          </ul>
        </div>
      </CardContent>
    </Card>
  );
}
