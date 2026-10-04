export const signupDepartments = ['Marketing', 'Sales', 'Driver', 'Office Admin', 'Finance', 'HR'] as const;
export const departmentLabel = (department: string) => department === 'HR' ? 'Human Resources' : department;
export const isSignupDepartment = (value: unknown): value is typeof signupDepartments[number] =>
  typeof value === 'string' && signupDepartments.some(department => department === value);
