export type DeskRole = 'owner' | 'clerk';

export function homePath(role: DeskRole): '/admin' | '/deals' {
  return role === 'owner' ? '/admin' : '/deals';
}
