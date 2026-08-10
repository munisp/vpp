import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Fingerprint, Loader2, AlertCircle, CheckCircle2 } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { toast } from "sonner";
import { useBiometricAuth } from "@/hooks/useBiometricAuth";

interface BiometricLoginProps {
  onSuccess?: () => void;
  onError?: (error: string) => void;
}

export function BiometricLogin({ onSuccess, onError }: BiometricLoginProps) {
  const {
    isSupported,
    isRegistered,
    isLoading,
    error,
    authenticate,
  } = useBiometricAuth();

  const handleBiometricLogin = async () => {
    const success = await authenticate();
    if (success) {
      toast.success("Biometric authentication successful!");
      onSuccess?.();
    } else {
      const message = error || "Biometric authentication failed";
      onError?.(message);
      toast.error(message);
    }
  };

  if (!isSupported && !isLoading) {
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

        {!isRegistered && !isLoading && (
          <Alert>
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              No biometric credentials are registered for your account. Register a
              device in Biometric Settings first.
            </AlertDescription>
          </Alert>
        )}

        <Button
          onClick={handleBiometricLogin}
          disabled={isLoading || !isRegistered}
          className="w-full gap-2"
          size="lg"
        >
          {isLoading ? (
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

interface BiometricRegistrationProps {
  onRegistered?: () => void;
}

export function BiometricRegistration({ onRegistered }: BiometricRegistrationProps) {
  const {
    isSupported,
    isRegistered,
    isLoading,
    error,
    register,
  } = useBiometricAuth();

  const handleRegisterBiometric = async () => {
    const result = await register();
    if (result.success) {
      if (result.verified) {
        toast.success("Biometric credential registered and verified.");
      } else {
        // Server stores the credential but cannot complete attestation
        // trust-chain verification until the first verified sign-in.
        toast.success("Biometric credential registered", {
          description:
            result.message ||
            "Credential stored, verification pending. It will be fully verified on your first successful biometric sign-in.",
        });
      }
      onRegistered?.();
    } else {
      toast.error(result.message || "Registration failed");
    }
  };

  if (!isSupported && !isLoading) {
    return (
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" />
        <AlertDescription>
          Biometric authentication is not supported on this device or browser.
        </AlertDescription>
      </Alert>
    );
  }

  if (isRegistered) {
    return (
      <Alert>
        <CheckCircle2 className="h-4 w-4" />
        <AlertDescription>
          A biometric credential is registered for your account on the server.
          Newly registered credentials are fully verified after your first
          successful biometric sign-in.
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
          disabled={isLoading}
          className="w-full gap-2"
        >
          {isLoading ? (
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
