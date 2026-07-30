'use client';

import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  useAdminUsers,
  useCreateAdminUser,
  useDeleteAdminUser,
  useUpdateAdminUser,
  type AdminUser,
} from '@/hooks/use-admin-users';
import { useAuth } from '@/hooks/use-auth';
import { Edit3, KeyRound, Loader2, Plus, Shield, Trash2, UserRound, Users } from 'lucide-react';

function errorMessage(error: unknown, fallback: string) {
  return typeof error === 'object' && error !== null && 'message' in error
    ? String((error as { message?: unknown }).message)
    : fallback;
}

function formatDate(value: string) {
  return new Date(value).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export default function AdminUsersPage() {
  const { user: currentUser } = useAuth();
  const { data, isLoading, isError } = useAdminUsers();
  const createUser = useCreateAdminUser();
  const updateUser = useUpdateAdminUser();
  const deleteUser = useDeleteAdminUser();
  const users = data?.items || [];

  const [createOpen, setCreateOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<AdminUser | null>(null);

  const adminCount = users.filter((user) => user.is_admin).length;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground sm:text-3xl">User Management</h1>
          <p className="mt-1 text-muted-foreground">Create accounts and manage admin access</p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="mr-2 h-4 w-4" />
          Add User
        </Button>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Users</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {isLoading ? <Skeleton className="h-8 w-12" /> : <div className="text-2xl font-bold">{users.length}</div>}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Admins</CardTitle>
            <Shield className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {isLoading ? <Skeleton className="h-8 w-12" /> : <div className="text-2xl font-bold">{adminCount}</div>}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Local Passwords</CardTitle>
            <KeyRound className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className="h-8 w-12" />
            ) : (
              <div className="text-2xl font-bold">{users.filter((user) => user.has_password).length}</div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Accounts</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-3">
              {Array.from({ length: 5 }).map((_, index) => (
                <Skeleton key={index} className="h-16 w-full" />
              ))}
            </div>
          ) : isError ? (
            <p className="text-sm text-destructive">Failed to load users.</p>
          ) : users.length === 0 ? (
            <p className="text-sm text-muted-foreground">No users found.</p>
          ) : (
            <div className="divide-y divide-border">
              {users.map((account) => {
                const isCurrentUser = currentUser?.id === account.id;
                const deleteDisabled = isCurrentUser || deleteUser.isPending;
                return (
                  <div
                    key={account.id}
                    className="grid gap-3 py-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-center"
                  >
                    <div className="flex min-w-0 items-start gap-3">
                      <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted">
                        <UserRound className="h-4 w-4 text-muted-foreground" />
                      </div>
                      <div className="min-w-0 space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="font-medium text-foreground">{account.username}</p>
                          {account.is_admin && <Badge>Admin</Badge>}
                          {isCurrentUser && <Badge variant="secondary">You</Badge>}
                          {account.authentik_sub && <Badge variant="outline">Authentik</Badge>}
                        </div>
                        <p className="break-all text-sm text-muted-foreground">
                          {account.email || 'No email'}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Created {formatDate(account.created_at)} · {account.has_password ? 'Password login enabled' : 'No local password'}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 md:justify-end">
                      <Button variant="outline" size="sm" onClick={() => setEditingUser(account)}>
                        <Edit3 className="mr-2 h-4 w-4" />
                        Edit
                      </Button>
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => deleteUser.mutate(account.id)}
                        disabled={deleteDisabled}
                        title={isCurrentUser ? 'You cannot delete your own account' : undefined}
                      >
                        {deleteUser.isPending ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Trash2 className="h-4 w-4" />
                        )}
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {deleteUser.isError && (
            <p className="mt-3 text-sm text-destructive">
              {errorMessage(deleteUser.error, 'Failed to delete user.')}
            </p>
          )}
        </CardContent>
      </Card>

      <UserFormDialog
        mode="create"
        open={createOpen}
        onOpenChange={setCreateOpen}
        isPending={createUser.isPending}
        error={createUser.error}
        onSubmit={(payload) => {
          if (!payload.password) return;
          createUser.mutate(
            { ...payload, password: payload.password },
            { onSuccess: () => setCreateOpen(false) }
          );
        }}
      />

      <UserFormDialog
        mode="edit"
        user={editingUser}
        open={Boolean(editingUser)}
        onOpenChange={(open) => {
          if (!open) setEditingUser(null);
        }}
        isPending={updateUser.isPending}
        error={updateUser.error}
        onSubmit={(payload) => {
          if (!editingUser) return;
          updateUser.mutate(
            { id: editingUser.id, ...payload },
            { onSuccess: () => setEditingUser(null) }
          );
        }}
      />
    </div>
  );
}

function UserFormDialog({
  mode,
  user,
  open,
  onOpenChange,
  isPending,
  error,
  onSubmit,
}: {
  mode: 'create' | 'edit';
  user?: AdminUser | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isPending: boolean;
  error: unknown;
  onSubmit: (payload: { username: string; email: string; password?: string; is_admin: boolean }) => void;
}) {
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    if (!open) return;
    setUsername(user?.username || '');
    setEmail(user?.email || '');
    setPassword('');
    setIsAdmin(Boolean(user?.is_admin));
  }, [open, user]);

  const isCreate = mode === 'create';
  const disabled = isPending || !username.trim() || (isCreate && password.length < 4);

  const handleSubmit = () => {
    onSubmit({
      username: username.trim(),
      email: email.trim(),
      password: password || undefined,
      is_admin: isAdmin,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isCreate ? 'Add User' : 'Edit User'}</DialogTitle>
          <DialogDescription>
            {isCreate ? 'Create a local account.' : 'Update account details, role, or password.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">Username</label>
            <Input value={username} onChange={(event) => setUsername(event.target.value)} />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">Email</label>
            <Input type="email" value={email} onChange={(event) => setEmail(event.target.value)} />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">
              {isCreate ? 'Password' : 'New Password'}
            </label>
            <Input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder={isCreate ? '' : 'Leave blank to keep current password'}
            />
          </div>
          <label className="flex items-center gap-3 rounded-md border border-border p-3">
            <input
              type="checkbox"
              checked={isAdmin}
              onChange={(event) => setIsAdmin(event.target.checked)}
              className="h-4 w-4 rounded border-border bg-background text-primary"
            />
            <span className="text-sm font-medium text-foreground">Admin access</span>
          </label>
          {Boolean(error) && (
            <p className="text-sm text-destructive">
              {errorMessage(error, isCreate ? 'Failed to create user.' : 'Failed to update user.')}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={disabled}>
            {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {isCreate ? 'Create User' : 'Save Changes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
