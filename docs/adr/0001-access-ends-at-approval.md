# Access ends when a Refund Request is approved, not when the money is sent

When a Platform Admin approves a Refund Request, the Enrollment that came from that purchase ends straight away, and any Unclaimed Seats of a Team Licence are voided. We tie access to the decision rather than to the Refund, because the money side (Pending, Issued, Failed Refund) can lag or fail, and a Failed Refund does not change the decision.

To end the right Enrollment, every Enrollment records where it came from: the learner's own purchase or a Claimed Seat. Without that, a Team Admin who also bought the course personally would lose their own access when their Team Licence is refunded. A learner keeps at most one Enrollment per course.

While a Team Licence has an Open Refund Request, its Unclaimed Seats cannot be claimed. Otherwise a seat claimed between request and decision would make the request impossible to approve.

## Considered Options

- **End access when the Refund is Issued.** Rejected: ties access to a payment flow that is out of our hands and can fail without changing the decision.
- **Re-check Claimed Seats at approval and only allow declining.** Rejected: leaves Platform Admins with requests they can never approve.

## Consequences

- Learning progress (lesson progress, watch events, quiz attempts) is kept. A learner who buys the course again gets it back, and it counts towards the new purchase's watch-time limit.
- Decisions are final; there is no undo.
