import { useState } from 'react';
import type { FormEvent } from 'react';
import { auth as authApi } from '../lib/api';
import { useAuth } from '../contexts/AuthContext';
import StoresPage from './Stores';

export default function Profile() {
  const { user, updateUser } = useAuth();

  const [fullName, setFullName] = useState(user?.full_name ?? '');
  const [email, setEmail] = useState(user?.email ?? '');
  const [profileMsg, setProfileMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [savingProfile, setSavingProfile] = useState(false);

  const [newPw, setNewPw] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [pwMsg, setPwMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [savingPw, setSavingPw] = useState(false);

  const saveProfile = async (e: FormEvent) => {
    e.preventDefault();
    setProfileMsg(null);
    setSavingProfile(true);
    try {
      const res = await authApi.updateProfile({
        full_name: fullName.trim(),
        email: email.trim().toLowerCase(),
      });
      updateUser(res.user);
      setProfileMsg({ ok: true, text: 'Profile updated.' });
    } catch (err) {
      setProfileMsg({ ok: false, text: err instanceof Error ? err.message : 'Could not update profile.' });
    } finally {
      setSavingProfile(false);
    }
  };

  const savePassword = async (e: FormEvent) => {
    e.preventDefault();
    setPwMsg(null);
    if (newPw.length < 8) {
      setPwMsg({ ok: false, text: 'New password must be at least 8 characters.' });
      return;
    }
    if (newPw !== confirmPw) {
      setPwMsg({ ok: false, text: 'New password and confirmation do not match.' });
      return;
    }
    setSavingPw(true);
    try {
      await authApi.changePassword({ new_password: newPw });
      setPwMsg({ ok: true, text: 'Password changed. Any other devices signed in to your account were signed out.' });
      setNewPw(''); setConfirmPw('');
    } catch (err) {
      setPwMsg({ ok: false, text: err instanceof Error ? err.message : 'Could not change password.' });
    } finally {
      setSavingPw(false);
    }
  };

  return (
    <div className="page">
      <h2>Profile</h2>
      <div className="profile-grid">
        <form className="profile-card" onSubmit={saveProfile}>
          <h3>Account details</h3>
          {profileMsg && <div className={`profile-msg ${profileMsg.ok ? 'ok' : 'err'}`}>{profileMsg.text}</div>}
          <label className="profile-field">
            <span>Name</span>
            <input type="text" value={fullName} onChange={e => setFullName(e.target.value)} placeholder="Your name" autoComplete="name" />
          </label>
          <label className="profile-field">
            <span>Email</span>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@store.com" autoComplete="email" />
          </label>
          <button type="submit" className="btn" disabled={savingProfile}>
            {savingProfile ? 'Saving...' : 'Save changes'}
          </button>
        </form>

        <form className="profile-card" onSubmit={savePassword}>
          <h3>Change password</h3>
          {pwMsg && <div className={`profile-msg ${pwMsg.ok ? 'ok' : 'err'}`}>{pwMsg.text}</div>}
          <label className="profile-field">
            <span>New password</span>
            <input type="password" value={newPw} onChange={e => setNewPw(e.target.value)} placeholder="At least 8 characters" autoComplete="new-password" />
          </label>
          <label className="profile-field">
            <span>Confirm new password</span>
            <input type="password" value={confirmPw} onChange={e => setConfirmPw(e.target.value)} autoComplete="new-password" />
          </label>
          <p className="profile-help">Saving signs out any other devices currently using this account.</p>
          <button type="submit" className="btn" disabled={savingPw || !newPw}>
            {savingPw ? 'Updating...' : 'Update password'}
          </button>
        </form>
      </div>

      <section className="profile-stores">
        <StoresPage embedded />
      </section>
    </div>
  );
}
