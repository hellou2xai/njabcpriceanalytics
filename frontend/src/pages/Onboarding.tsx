import StoresPage from './Stores';
import { useAuth } from '../contexts/AuthContext';

/**
 * Mandatory first-run step. A signed-in user with no store sees this and
 * cannot reach the app until they add one. Reuses the real Stores form
 * (with Google address lookup); adding a store invalidates the ['stores']
 * query, which flips the StoreGate to the app.
 */
export default function Onboarding() {
  const { user, logout } = useAuth();
  const name = user?.full_name?.split(' ')[0] || 'there';

  return (
    <div className="onboarding">
      <div className="onboarding-card">
        <h1>Welcome, {name}.</h1>
        <p className="onboarding-lead">
          Add your store to finish setting up. Add every store you own; the more you add, the
          more granular your pricing and deal analytics get. At least one store is required to continue.
        </p>
        <StoresPage onboarding />
        <button className="onboarding-signout" onClick={logout}>Sign out</button>
      </div>
    </div>
  );
}
