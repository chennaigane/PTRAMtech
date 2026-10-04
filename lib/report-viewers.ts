// Server-side report sharing allowlist. App roles/status are checked on every sync.
// These emails do not grant app access or override Google owner controls.
export const reportViewers:Record<string,string|string[]>={
 '+919600043768':'ptramkumaarenterprises25@gmail.com',
 // Both authorized Manager Google accounts are read-only viewers. The phone
 // remains the app identity whose active Manager role is checked at sync time.
 '+919940180612':['mohanagane08@gmail.com','chennaigane@gmail.com'],
};
