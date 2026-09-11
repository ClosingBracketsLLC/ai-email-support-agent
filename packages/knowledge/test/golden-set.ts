/** question → the chunk (by heading) that answers it, plus the decoy chunks every synthetic org gets. */
export const GOLDEN: { question: string; heading: string; content: string }[] = [
  { question: 'How long do I have to return an item?', heading: 'Returns', content: 'Returns are accepted within 30 days of delivery when the item is unused and in its original packaging.' },
  { question: 'Do you ship internationally?', heading: 'International shipping', content: 'We ship internationally to most countries; international shipping takes 7 to 14 business days.' },
  { question: 'Can I change my delivery address after ordering?', heading: 'Changing a delivery address', content: 'You can change the delivery address of an order until it ships by replying to the confirmation email.' },
  { question: 'What payment methods do you accept?', heading: 'Payment methods', content: 'We accept Visa, Mastercard, American Express, PayPal and Apple Pay as payment methods.' },
  { question: 'How do I track my order?', heading: 'Order tracking', content: 'Track your order with the tracking link in the shipping confirmation email; tracking updates every 12 hours.' },
  { question: 'Are sale items refundable?', heading: 'Sale items', content: 'Sale items are final and cannot be refunded or exchanged; sale prices are marked on the product page.' },
  { question: 'Do gift cards expire?', heading: 'Gift cards', content: 'Gift cards never expire and can be used on any product; gift card balances show at checkout.' },
  { question: 'How do I reset my password?', heading: 'Password reset', content: 'Reset your password from the sign-in page with the Forgot password link; the reset email arrives within a minute.' },
  { question: 'What is your warranty?', heading: 'Warranty', content: 'Every product carries a two-year warranty against manufacturing defects; warranty claims start with a photo.' },
  { question: 'Can I cancel a subscription?', heading: 'Cancelling a subscription', content: 'Cancel a subscription any time from your account page; the subscription stays active until the end of the paid period.' },
  { question: 'Do you offer wholesale pricing?', heading: 'Wholesale', content: 'Wholesale pricing is available for orders of 50 units or more; contact the wholesale team for a quote.' },
  { question: 'How do I use a discount code?', heading: 'Discount codes', content: 'Enter a discount code in the code box at checkout; one discount code applies per order.' },
  { question: 'What sizes do the t-shirts come in?', heading: 'T-shirt sizes', content: 'T-shirts come in sizes XS to XXL; the size chart on each product page lists chest measurements.' },
  { question: 'Is the packaging recyclable?', heading: 'Packaging', content: 'Our packaging is fully recyclable cardboard and paper tape; no plastic is used in packaging.' },
  { question: 'How do I contact support by phone?', heading: 'Phone support', content: 'Phone support is available on weekdays from 9 to 5; the phone number is on the contact page.' },
  { question: 'Do you have a student discount?', heading: 'Student discount', content: 'Students get a 15 percent student discount after verifying with a school email address.' },
  { question: 'What happens if my parcel is lost?', heading: 'Lost parcels', content: 'A parcel that shows no tracking movement for 10 days is treated as lost and replaced or refunded.' },
  { question: 'Can I pre-order out of stock items?', heading: 'Pre-orders', content: 'Out of stock items with a restock date can be pre-ordered; pre-orders are charged when they ship.' },
  { question: 'How do I exchange for a different size?', heading: 'Exchanges', content: 'Exchange for a different size by starting a return and ordering the new size; exchanges ship free.' },
  { question: 'Where is my invoice?', heading: 'Invoices', content: 'Your invoice is attached to the order confirmation email and available from the orders page as a PDF.' },
]

export const DECOYS: { heading: string; content: string }[] = Array.from({ length: 30 }, (_, i) => ({
  heading: `About us ${i}`,
  content: `Founded in ${1990 + i}, our team of ${i + 3} people works from a studio by the river and loves what it does.`,
}))
