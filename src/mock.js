// Sample data used when USE_MOCK=true, so the app runs and can be demoed
// before real Zoho Books credentials are connected.

export const mockCustomers = [
  {
    contact_id: "cust_1",
    contact_name: "Jay Mendonca",
    email: "jay@example.com",
    phone: "+971500000001",
    vehicle: { plate: "E 61146", contract_end: "14 Aug 2026" },
    plates: ["E 61146", "AA 96766", "BB 24058"],
  },
  {
    contact_id: "cust_2",
    contact_name: "Sara Ahmed",
    email: "sara@example.com",
    phone: "+971500000002",
    vehicle: { name: "Ford Mustang GT", year: "2024", plate: "DXB · 10233", contract_end: "02 Sep 2026" },
  },
];

export const mockInvoices = [
  { invoice_id: "inv_1058", contact_id: "cust_1", invoice_number: "INV-1058", date: "2026-07-12", due_date: "2026-07-22", total: 2750, balance: 2750, status: "overdue", items: "Salik toll top-up" },
  { invoice_id: "inv_1051", contact_id: "cust_1", invoice_number: "INV-1051", date: "2026-07-01", due_date: "2026-07-11", total: 1500, balance: 1500, status: "unpaid", items: "Traffic fine - speeding" },
  { invoice_id: "inv_1042", contact_id: "cust_1", invoice_number: "INV-1042", date: "2026-06-20", due_date: "2026-06-30", total: 1500, balance: 0, status: "paid", items: "Monthly rent - July" },
  { invoice_id: "inv_1033", contact_id: "cust_1", invoice_number: "INV-1033", date: "2026-06-05", due_date: "2026-06-15", total: 1500, balance: 0, status: "paid", items: "Monthly rent - June" },
  { invoice_id: "inv_2001", contact_id: "cust_2", invoice_number: "INV-2001", date: "2026-07-08", due_date: "2026-07-18", total: 3200, balance: 3200, status: "unpaid", items: "Monthly rent" },
];

export const mockPayments = [
  { payment_id: "pay_87", contact_id: "cust_1", payment_number: "RCPT-0087", date: "2026-06-20", amount: 1500, payment_mode: "Visa •••• 4291", invoice_numbers: "INV-1042" },
  { payment_id: "pay_80", contact_id: "cust_1", payment_number: "RCPT-0080", date: "2026-06-21", amount: 3500, payment_mode: "Bank transfer", invoice_numbers: "INV-1030, INV-1025" },
  { payment_id: "pay_60", contact_id: "cust_2", payment_number: "RCPT-0060", date: "2026-07-02", amount: 1000, payment_mode: "Visa •••• 7781", invoice_numbers: "INV-1990" },
];
