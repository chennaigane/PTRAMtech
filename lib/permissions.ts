// Role rules shared by the API (enforcement) and the dashboard (what to show).
// Admin: everything. Manager: own work + Employees in their team.
// Employee (Marketing / Sales): own work only.
export type Person = {id: string, role: string, team: string | null};

/** A Manager's assigned team: Employees with the same team. */
export const inTeam = (me: Person, p: Person) =>
  me.role === 'Manager' && !!me.team && p.role === 'Employee' && p.team === me.team;

/** May see this person's locations, journeys, attendance, claims and incidents. */
export const canView = (me: Person, p: Person) => me.role === 'Admin' || me.id === p.id || inTeam(me, p);

/** May approve / mark paid this person's claims and acknowledge their incidents. Managers cannot self-approve. */
export const canReview = (me: Person, p: Person) => me.role === 'Admin' || inTeam(me, p);

export const can = {
  companyDashboard: (me: Person) => (me.role === 'Admin' || me.role === 'Manager'),
  manageAccounts: (me: Person) => me.role === 'Admin',
  configure: (me: Person) => me.role === 'Admin', // branches and reimbursement rates
  viewConfiguration: (me: Person) => (me.role === 'Admin' || me.role === 'Manager'),
  exportReports: (me: Person) => (me.role === 'Admin' || me.role === 'Manager'),
};
