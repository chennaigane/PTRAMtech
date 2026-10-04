// Designated bootstrap identity only. Never grant access based on an unverified phone number.
export const accessSetup = {
  designatedAdminPhone: '+919600043768',
  activationStatus: 'pending_activation',
  accessGrantedBy: 'Admin',
  roles: ['Admin', 'Manager', 'Representative'],
  representativeTeams: ['Marketing', 'Sales'],
  dashboardRoles: ['Admin', 'Manager'],
  publicRegistrationStatus: 'pending_admin_approval',
} as const;
