import { useState, useEffect } from 'react';
import { trpc } from '@/lib/trpc';

export interface BiometricAuthState {
  isSupported: boolean;
  isRegistered: boolean;
  isLoading: boolean;
  error: string | null;
}

export function useBiometricAuth() {
  const [state, setState] = useState<BiometricAuthState>({
    isSupported: false,
    isRegistered: false,
    isLoading: true,
    error: null,
  });

  const registerMutation = trpc.biometric?.registerCredential.useMutation();
  const authenticateMutation = trpc.biometric?.authenticate.useMutation();
  const checkStatusQuery = trpc.biometric?.getStatus.useQuery(undefined, {
    enabled: false,
  });

  useEffect(() => {
    checkSupport();
  }, []);

  const checkSupport = async () => {
    // Check if WebAuthn is supported
    const isSupported = 
      window.PublicKeyCredential !== undefined &&
      navigator.credentials !== undefined;

    if (!isSupported) {
      setState(prev => ({ ...prev, isSupported: false, isLoading: false }));
      return;
    }

    // Check if user has registered credentials
    try {
      const status = await checkStatusQuery.refetch();
      setState({
        isSupported: true,
        isRegistered: status.data?.isRegistered || false,
        isLoading: false,
        error: null,
      });
    } catch (error) {
      setState(prev => ({ ...prev, isSupported: true, isLoading: false }));
    }
  };

  const register = async (): Promise<{ success: boolean; verified: boolean; message?: string }> => {
    if (!state.isSupported) {
      setState(prev => ({ ...prev, error: 'Biometric authentication not supported' }));
      return { success: false, verified: false };
    }

    setState(prev => ({ ...prev, isLoading: true, error: null }));

    try {
      // Get registration options from server (the server derives the WebAuthn
      // user handle from the authenticated session — never hardcoded here).
      const options = await registerMutation.mutateAsync({ action: 'get-options' });

      // Create credential
      const credential = await navigator.credentials.create({
        publicKey: {
          challenge: base64ToArrayBuffer(options.challenge || ''),
          rp: {
            name: options.rpName || 'VPP Platform',
            id: options.rpId || window.location.hostname,
          },
          user: {
            id: base64ToArrayBuffer(options.userId || ''),
            name: options.userName || 'user',
            displayName: options.userDisplayName || 'User',
          },
          pubKeyCredParams: (options.pubKeyCredParams || [
            { type: 'public-key' as const, alg: -7 },
            { type: 'public-key' as const, alg: -257 },
          ]) as any,
          authenticatorSelection: {
            authenticatorAttachment: 'platform', // Use platform authenticator (Touch ID, Face ID, Windows Hello)
            requireResidentKey: false,
            userVerification: 'required',
          },
          timeout: 60000,
          attestation: 'none',
        },
      }) as PublicKeyCredential;

      if (!credential) {
        throw new Error('Failed to create credential');
      }

      // Send credential to server; the server only stores it after validating
      // the challenge and parsing the attestation object.
      const response = credential.response as AuthenticatorAttestationResponse;
      const result: any = await registerMutation.mutateAsync({
        action: 'verify',
        credentialId: arrayBufferToBase64(credential.rawId),
        attestationObject: arrayBufferToBase64(response.attestationObject),
        clientDataJSON: arrayBufferToBase64(response.clientDataJSON),
      });

      if (!result?.success) {
        throw new Error(result?.message || 'Server did not store the credential');
      }

      setState(prev => ({ ...prev, isRegistered: true, isLoading: false }));
      return {
        success: true,
        verified: result.verified ?? false,
        message: result.message,
      };
    } catch (error: any) {
      const errorMessage = error.message || 'Failed to register biometric authentication';
      setState(prev => ({ ...prev, isLoading: false, error: errorMessage }));
      return { success: false, verified: false, message: errorMessage };
    }
  };

  const authenticate = async (): Promise<boolean> => {
    if (!state.isSupported || !state.isRegistered) {
      setState(prev => ({ ...prev, error: 'Biometric authentication not available' }));
      return false;
    }

    setState(prev => ({ ...prev, isLoading: true, error: null }));

    try {
      // Get authentication options from server
      const options = await authenticateMutation.mutateAsync({ action: 'get-options' });

      // Get assertion
      const assertion = await navigator.credentials.get({
        publicKey: {
          challenge: base64ToArrayBuffer(options.challenge || ''),
          rpId: options.rpId || window.location.hostname,
          allowCredentials: (options.allowCredentials || []).map((cred: any) => ({
            type: 'public-key',
            id: base64ToArrayBuffer(cred.id),
          })),
          timeout: 60000,
          userVerification: 'required',
        },
      }) as PublicKeyCredential;

      if (!assertion) {
        throw new Error('Authentication failed');
      }

      // Send assertion to server
      const response = assertion.response as AuthenticatorAssertionResponse;
      const result = await authenticateMutation.mutateAsync({
        action: 'verify',
        credentialId: arrayBufferToBase64(assertion.rawId),
        authenticatorData: arrayBufferToBase64(response.authenticatorData),
        clientDataJSON: arrayBufferToBase64(response.clientDataJSON),
        signature: arrayBufferToBase64(response.signature),
        userHandle: response.userHandle ? arrayBufferToBase64(response.userHandle) : '',
      });

      setState(prev => ({ ...prev, isLoading: false }));
      return result?.success ?? false;
    } catch (error: any) {
      const errorMessage = error.message || 'Authentication failed';
      setState(prev => ({ ...prev, isLoading: false, error: errorMessage }));
      return false;
    }
  };

  const unregister = async (): Promise<boolean> => {
    if (!state.isRegistered) {
      return false;
    }

    setState(prev => ({ ...prev, isLoading: true, error: null }));

    try {
      await registerMutation.mutateAsync({ action: 'unregister' });
      setState(prev => ({ ...prev, isRegistered: false, isLoading: false }));
      return true;
    } catch (error: any) {
      const errorMessage = error.message || 'Failed to unregister';
      setState(prev => ({ ...prev, isLoading: false, error: errorMessage }));
      return false;
    }
  };

  return {
    ...state,
    register,
    authenticate,
    unregister,
    refresh: checkSupport,
  };
}

// Helper functions for base64 encoding/decoding
function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binaryString = window.atob(base64.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return window.btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
