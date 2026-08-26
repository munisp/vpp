export { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";

export const APP_TITLE = import.meta.env.VITE_APP_TITLE || "VPP Platform";
export const APP_LOGO = "https://placehold.co/128x128/E1E7EF/1F2937?text=VPP";

/** Redirect to the server-owned Keycloak authorization-code entrypoint. */
export const getLoginUrl = () => {
  const redirectUri = `${window.location.origin}/api/oauth/callback`;
  const url = new URL("/api/oauth/authorize", window.location.origin);
  url.searchParams.set("redirect_uri", redirectUri);
  return url.toString();
};
