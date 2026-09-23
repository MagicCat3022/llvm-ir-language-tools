; A small program: a loop, a branch, a helper from math.ll, and printf.
@summary = private constant [22 x i8] c"total = %d, gcd = %d\0A\00"

declare i32 @printf(ptr, ...)
declare i32 @gcd(i32 %a, i32 %b)

define i32 @sum_to(i32 %n) {
entry:
  br label %loop

loop:
  %i = phi i32 [ 0, %entry ], [ %next, %body ]
  %total = phi i32 [ 0, %entry ], [ %updated, %body ]
  %done = icmp sge i32 %i, %n
  br i1 %done, label %exit, label %body

body:
  %updated = add i32 %total, %i
  %next = add i32 %i, 1
  br label %loop

exit:
  ret i32 %total
}

define i32 @clamp(i32 %value, i32 %low, i32 %high) {
entry:
  %too_low = icmp slt i32 %value, %low
  br i1 %too_low, label %use_low, label %check_high

use_low:
  ret i32 %low

check_high:
  %too_high = icmp sgt i32 %value, %high
  %result = select i1 %too_high, i32 %high, i32 %value
  ret i32 %result
}

define i32 @main() {
entry:
  %total = call i32 @sum_to(i32 10)
  %bounded = call i32 @clamp(i32 %total, i32 0, i32 40)
  %divisor = call i32 @gcd(i32 %bounded, i32 12)
  call i32 (ptr, ...) @printf(ptr @summary, i32 %bounded, i32 %divisor)
  ret i32 0
}
