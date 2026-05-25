import { useEffect, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import './Legal.css';

const UPDATED = 'May 25, 2026';

// Apply the saved theme on these standalone pages (they render outside the app
// Layout, which is what normally sets data-theme). Keeps light/dark consistent.
function useSavedTheme() {
  useEffect(() => {
    const t = (localStorage.getItem('theme') as 'dark' | 'light') ?? 'light';
    document.documentElement.setAttribute('data-theme', t);
  }, []);
}

function LegalShell({ kicker, title, lead, children }: {
  kicker: string; title: string; lead: ReactNode; children: ReactNode;
}) {
  useSavedTheme();
  return (
    <div className="legal">
      <div className="legal-bar">
        <div className="legal-bar-inner">
          <Link to="/" className="legal-brand" aria-label="CELR.ai home">
            <span className="legal-logo">C</span>
            <span className="legal-wordmark">CELR<span className="dot">.</span>ai</span>
          </Link>
          <Link to="/" className="legal-home">← Back to home</Link>
        </div>
      </div>
      <main className="legal-main">
        <div className="legal-kicker">{kicker}</div>
        <h1>{title}</h1>
        <div className="legal-updated">Last updated: {UPDATED}</div>
        <p className="legal-lead">{lead}</p>
        <div className="legal-doc">{children}</div>
        <div className="legal-foot">
          <div className="links">
            <Link to="/terms">Terms of Service</Link>
            <Link to="/privacy">Privacy Policy</Link>
            <Link to="/">Home</Link>
          </div>
          <span className="copy">© 2026 CELR.ai · A U2xAI product</span>
        </div>
      </main>
    </div>
  );
}

export function Terms() {
  return (
    <LegalShell
      kicker="Legal"
      title="Terms of Service"
      lead={
        <>These Terms of Service ("Terms") govern your access to and use of CELR.ai (the "Service"),
        operated by U2xAI ("CELR.ai", "we", "us", or "our"). By creating an account or using the
        Service, you agree to these Terms. If you do not agree, do not use the Service.</>
      }
    >
      <div className="legal-callout">
        <strong>Important.</strong> CELR.ai is an informational and analytical tool. The data we
        present is derived from public New Jersey ABC filings and wholesaler price lists, which are
        produced by third parties. We do not guarantee the accuracy, completeness, or timeliness of
        that data. Always confirm pricing, rebates, and availability directly with the wholesaler
        and the official Current Price List before making any purchasing, pricing, or business
        decision. You are solely responsible for decisions you make.
      </div>

      <section>
        <h2>Acceptance of these Terms</h2>
        <p>By accessing or using the Service, registering an account, or clicking to accept these
        Terms, you confirm that you have read, understood, and agree to be bound by them, and that
        you are at least 21 years of age and authorized to act for your business. If you use the
        Service on behalf of an entity, you represent that you are authorized to bind that entity.</p>
      </section>

      <section>
        <h2>Description of the Service</h2>
        <p>CELR.ai ingests publicly filed New Jersey Alcoholic Beverage Control ("NJ ABC") Current
        Price Lists and related wholesaler data, normalizes it, and presents analytics such as
        rebate (RIP) detection, price-change tracking, and cost and margin estimates. The Service is
        a decision-support tool only. It does not place orders, transact on your behalf, or
        integrate with your point-of-sale system.</p>
      </section>

      <section>
        <h2>Not professional advice</h2>
        <p>The Service and its outputs do not constitute legal, regulatory, accounting, tax,
        financial, or business advice, and are not a substitute for your own judgment or for advice
        from a qualified professional. Nothing in the Service should be relied upon as a guarantee of
        any outcome, savings, margin, or rebate eligibility.</p>
      </section>

      <section>
        <h2>Source data and no accuracy guarantee</h2>
        <p>The information in the Service originates from third-party and public sources, including
        NJ ABC filings and wholesaler price lists. These sources may contain errors, omissions, or
        delays, and may change without notice. We process this data on an automated basis and may
        further transform or estimate values.</p>
        <ul>
          <li>We make no representation or warranty that any data, calculation, rebate, bracket, or
          price shown is accurate, complete, current, or applicable to your store.</li>
          <li>Rebate (RIP), post-off, and small-quantity tier eligibility is set by wholesalers and
          regulators, not by CELR.ai, and may differ from what is shown.</li>
          <li>You must independently verify any figure with the wholesaler and the official Current
          Price List before acting on it.</li>
          <li>We are not responsible for third-party data, for changes to it, or for any decision
          made in reliance on it.</li>
        </ul>
      </section>

      <section>
        <h2>Your responsibilities</h2>
        <ul>
          <li>Provide accurate account information and keep your credentials secure.</li>
          <li>Verify all data before relying on it for purchasing, pricing, or compliance.</li>
          <li>Comply with all applicable laws and regulations, including NJ ABC rules.</li>
          <li>Accept full responsibility for all decisions and actions taken using the Service.</li>
        </ul>
      </section>

      <section>
        <h2>Accounts</h2>
        <p>You are responsible for activity under your account and for maintaining the
        confidentiality of your password. Notify us promptly of any unauthorized use. We may
        suspend or terminate accounts that violate these Terms.</p>
      </section>

      <section>
        <h2>Acceptable use</h2>
        <p>You agree not to: (a) scrape, resell, redistribute, or commercially exploit the Service or
        its data except as expressly permitted; (b) reverse engineer, decompile, or attempt to
        derive source code; (c) interfere with or disrupt the Service; (d) access the Service by
        automated means without our consent; or (e) use the Service for any unlawful purpose.</p>
      </section>

      <section>
        <h2>Intellectual property</h2>
        <p>The Service, including its software, design, normalized datasets, analytics, and all
        related intellectual property, is owned by CELR.ai / U2xAI and protected by law. We grant
        you a limited, non-exclusive, non-transferable, revocable license to use the Service for
        your internal business purposes. The underlying public filings remain the property of their
        respective sources.</p>
      </section>

      <section>
        <h2>Communications, product improvement, and marketing</h2>
        <p>By creating an account, you agree that we may contact you using the email address, phone
        number, and other details you provide, for purposes including service and account
        notifications, customer support, research, product improvement, and marketing or promotional
        messages about CELR.ai. You may opt out of marketing communications at any time using the
        unsubscribe link or by contacting us; service and account messages may still be sent. Message
        and data rates may apply to any SMS communications.</p>
      </section>

      <section>
        <h2>Disclaimer of warranties</h2>
        <p>THE SERVICE AND ALL DATA ARE PROVIDED "AS IS" AND "AS AVAILABLE", WITHOUT WARRANTIES OF
        ANY KIND, WHETHER EXPRESS, IMPLIED, OR STATUTORY, INCLUDING WITHOUT LIMITATION IMPLIED
        WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, TITLE, NON-INFRINGEMENT,
        AND ACCURACY. WE DO NOT WARRANT THAT THE SERVICE WILL BE UNINTERRUPTED, ERROR-FREE, OR
        SECURE, OR THAT ANY DATA IS ACCURATE OR COMPLETE.</p>
      </section>

      <section>
        <h2>Limitation of liability</h2>
        <p>TO THE MAXIMUM EXTENT PERMITTED BY LAW, CELR.ai AND U2xAI, AND THEIR OWNERS, OFFICERS,
        EMPLOYEES, AND SUPPLIERS, WILL NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL,
        CONSEQUENTIAL, EXEMPLARY, OR PUNITIVE DAMAGES, OR FOR ANY LOSS OF PROFITS, REVENUE, DATA,
        GOODWILL, OR BUSINESS, ARISING OUT OF OR RELATED TO YOUR USE OF, OR INABILITY TO USE, THE
        SERVICE OR ANY DATA, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGES. OUR TOTAL
        AGGREGATE LIABILITY FOR ANY CLAIM RELATING TO THE SERVICE WILL NOT EXCEED THE GREATER OF THE
        AMOUNT YOU PAID US FOR THE SERVICE IN THE TWELVE MONTHS BEFORE THE CLAIM, OR ONE HUNDRED US
        DOLLARS ($100). Some jurisdictions do not allow certain limitations, so some of the above may
        not apply to you.</p>
      </section>

      <section>
        <h2>Indemnification</h2>
        <p>You agree to indemnify, defend, and hold harmless CELR.ai and U2xAI from and against any
        claims, liabilities, damages, losses, and expenses, including reasonable legal fees, arising
        out of or related to your use of the Service, your decisions made using the Service, or your
        violation of these Terms or any law.</p>
      </section>

      <section>
        <h2>Early access and changes to the Service</h2>
        <p>The Service is offered on an early-access basis and may be provided free of charge during
        this period. It may contain errors, and features may change, be limited, or be discontinued
        at any time without notice or liability. We provide no service-level commitment.</p>
      </section>

      <section>
        <h2>Changes to these Terms</h2>
        <p>We may update these Terms from time to time. Material changes will be reflected by the
        "Last updated" date above and, where appropriate, by notice. Your continued use of the
        Service after changes take effect constitutes acceptance of the revised Terms.</p>
      </section>

      <section>
        <h2>Termination</h2>
        <p>We may suspend or terminate your access at any time, with or without cause or notice. You
        may stop using the Service and request account deletion at any time. Sections that by their
        nature should survive termination will survive.</p>
      </section>

      <section>
        <h2>Governing law</h2>
        <p>These Terms are governed by the laws of the State of New Jersey, without regard to its
        conflict-of-laws rules. You agree to the exclusive jurisdiction of the state and federal
        courts located in New Jersey for any dispute not subject to other agreement.</p>
      </section>

      <section>
        <h2>Miscellaneous</h2>
        <p>If any provision of these Terms is held unenforceable, the remaining provisions remain in
        full effect. Our failure to enforce any right is not a waiver. These Terms, together with the
        Privacy Policy, are the entire agreement between you and us regarding the Service.</p>
      </section>

      <section>
        <h2>Contact</h2>
        <p>Questions about these Terms can be sent to <a href="mailto:hello@celr.ai">hello@celr.ai</a>.</p>
      </section>
    </LegalShell>
  );
}

export function Privacy() {
  return (
    <LegalShell
      kicker="Legal"
      title="Privacy Policy"
      lead={
        <>This Privacy Policy explains what information CELR.ai ("we", "us", or "our") collects, how
        we use it, and the choices you have. By using CELR.ai you agree to this Policy.</>
      }
    >
      <div className="legal-callout">
        <strong>Our promise.</strong> We do not sell, rent, or share your personal information with
        third parties. We store only the minimal account information needed to operate the Service,
        and you can request its deletion at any time. Any data we use for research or product
        improvement is aggregated and anonymized so that it cannot identify you.
      </div>

      <section>
        <h2>Overview</h2>
        <p>CELR.ai is a pricing and rebate analytics tool for New Jersey liquor retailers. We
        designed it to need as little personal information as possible. The market data we present
        comes from public NJ ABC filings and wholesaler price lists and does not contain your
        personal information.</p>
      </section>

      <section>
        <h2>Information we collect</h2>
        <ul>
          <li><strong>Account information</strong> you provide: your name, email address, phone
          number, store name, and, if you choose, your license number.</li>
          <li><strong>Authentication data</strong> needed to sign you in, such as a hashed password
          and session token. We never store your password in plain text.</li>
          <li><strong>Limited usage information</strong> needed to operate and secure the Service,
          such as basic logs.</li>
        </ul>
        <p className="muted">We do not collect payment card information during early access, and we
        do not request sensitive personal categories of data.</p>
      </section>

      <section>
        <h2>How we use information</h2>
        <ul>
          <li>To create and operate your account and authenticate you.</li>
          <li>To provide, maintain, secure, and support the Service.</li>
          <li>To communicate with you about your account and the Service.</li>
          <li>To contact you, where you have an account, for research, product improvement, and
          marketing, subject to your right to opt out of marketing.</li>
        </ul>
      </section>

      <section>
        <h2>We do not sell or share your personal data</h2>
        <p>We do not sell, rent, trade, or share your personal information with third parties for
        their own purposes. We do not store personal data beyond what is necessary to provide the
        Service to you. We may rely on trusted infrastructure providers (for example, hosting and
        email delivery) strictly to operate the Service on our behalf, under confidentiality
        obligations, and never for their own marketing.</p>
      </section>

      <section>
        <h2>Anonymized and aggregated data</h2>
        <p>We may create and use de-identified, aggregated data, derived from how the Service is used
        in general, for research, analytics, benchmarking, and product improvement. This data is
        stripped of personal identifiers and cannot reasonably be used to identify you or your store.
        Aggregated, anonymized insights are not personal information.</p>
      </section>

      <section>
        <h2>Communications and marketing</h2>
        <p>If you have an account, we may contact you by email or phone for service and account
        notices, research, product improvement, and marketing. You can opt out of marketing messages
        at any time through the unsubscribe link or by contacting us. We will still send essential
        service and account messages.</p>
      </section>

      <section>
        <h2>Cookies and local storage</h2>
        <p>We use a small amount of browser local storage and similar technology to keep you signed
        in and to remember preferences such as your theme. We do not use third-party advertising
        cookies or cross-site tracking.</p>
      </section>

      <section>
        <h2>Data security</h2>
        <p>We use reasonable administrative, technical, and organizational measures to protect your
        information, including encryption in transit and hashed passwords. No method of transmission
        or storage is completely secure, so we cannot guarantee absolute security.</p>
      </section>

      <section>
        <h2>Data retention</h2>
        <p>We keep account information for as long as your account is active or as needed to provide
        the Service. When you ask us to delete your account, we will delete or anonymize your
        personal information, except where we must retain limited records to comply with law or
        resolve disputes.</p>
      </section>

      <section>
        <h2>Your choices and rights</h2>
        <ul>
          <li>Access or update your account information from your profile, or by contacting us.</li>
          <li>Request deletion of your account and personal information.</li>
          <li>Opt out of marketing communications at any time.</li>
        </ul>
      </section>

      <section>
        <h2>Market and source data</h2>
        <p>The pricing, rebate, and product data shown in the Service comes from public NJ ABC
        filings and wholesaler price lists. It is third-party business data, not your personal
        information, and is handled under our Terms of Service.</p>
      </section>

      <section>
        <h2>Children</h2>
        <p>The Service is intended only for business owners and authorized staff who are at least 21
        years old. It is not directed to children, and we do not knowingly collect their
        information.</p>
      </section>

      <section>
        <h2>Changes to this Policy</h2>
        <p>We may update this Policy from time to time. Material changes will be reflected by the
        "Last updated" date above. Your continued use of the Service after changes take effect
        constitutes acceptance of the updated Policy.</p>
      </section>

      <section>
        <h2>Contact</h2>
        <p>Questions about this Policy or your data can be sent to
        {' '}<a href="mailto:hello@celr.ai">hello@celr.ai</a>.</p>
      </section>
    </LegalShell>
  );
}
