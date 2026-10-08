# Letting Horos pay one of your invoices

This is a pilot, not a product launch. It runs on Arc **testnet**, so the USDC is
test currency and nothing you do here can move real money. What we are testing is
whether the refusal is useful to you.

**Time it takes you: about ten minutes.** Two of those are a phone call.

**To start: email [kiter2509@gmail.com](mailto:kiter2509@gmail.com?subject=Horos%20pilot%20-%20one%20invoice)
with three lines — the vendor's name as it appears on their invoices, the address you pay them at
(only if that is USDC), and roughly what a typical invoice is for.** That is the whole intake, and
everything after it is us.

---

## What we are asking

Pay one real invoice — one you would otherwise pay by bank transfer — and tell us
what the refusal felt like when we engineer one on purpose.

We are not asking for your bank credentials, your ledger, or access to anything.
We need the invoice text and the address you would normally pay.

## What you get

**A refusal you can point at.** When a supplier's account details change, most
businesses have a policy that says "phone to confirm". That policy works right up
until the email arrives with a voice note attached that sounds like your supplier.
Horos does not have a policy. It has a contract that cannot be told to pay a new
address, and the refusal is a property of the code rather than of anyone's
diligence.

**A public record of who you have paid.** Every counterparty you pay gets a page
showing every account they have ever been paid at, and the signatures behind each
change. You can send it to your accountant. So can anyone else.

## The three steps

### 1. Tell us the vendor and the address you pay

One message with:

- the vendor's name, as it appears on their invoices
- the address you pay them at, **only if you already pay them in USDC** — otherwise
  we use a test address and the exercise is purely about the refusal
- roughly how much a typical invoice is for

That is the whole intake. No form, no account, no integration.

### 2. We register them, and the agent pays the first invoice

The first payment is what establishes the record. It is also the only payment that
is a genuine judgement call — from the second one onward there is something to
compare against, and that comparison is where the value is.

You will get a link to their public page and a decision card showing exactly what
the agent read off the invoice and why it decided what it did.

### 3. We engineer the attack, and you watch it refuse

This is the part worth your ten minutes.

We send the agent an invoice from your vendor that looks right, reads right, and
asks to be paid somewhere new. It will contain the things a real one contains — the
old account printed for credibility, urgency, and a request not to confirm.

**The agent will refuse it, and it will show you which sentence gave it away.**

If you want the other half of the story, your vendor can then genuinely change
accounts, and you can watch the two-signature ceremony that makes it legitimate.
That takes longer and needs their cooperation. Most people stop after step 3.

---

## Questions you will reasonably have

**Is this going to cost me anything?**
No. Testnet USDC, obtained from a faucet.

**Do I have to change how I pay anyone?**
No. This runs alongside whatever you do now.

**What if it refuses something legitimate?**
Tell us. A false refusal is the failure mode that matters most to us, because a
control that cries wolf gets turned off, and then it protects nobody. We would
rather know about it than not.

**Who can see my payment history?**
Anyone with the link. The record is public by design — a lineage that only you can
see is a lineage nobody else can check, and the entire point is that a supplier can
prove they were paid. Names and addresses only: no amounts, no invoice contents.

**What happens when I stop?**
The contracts are on a public testnet and will sit there. Nothing is connected to
your accounts.

---

## Why we are asking at all

Traction is judged at the Tameion Agents Hackathon, and synthetic data does not
count. That is the honest reason this document exists. The slightly better reason
is that a payment control nobody has used is a claim, and we would rather have
three businesses tell us it is wrong than thirty judges assume it works.
