; Helpers used from main.ll.
define i32 @gcd(i32 %a, i32 %b) {
entry:
  br label %check

check:
  %x = phi i32 [ %a, %entry ], [ %y, %step ]
  %y = phi i32 [ %b, %entry ], [ %remainder, %step ]
  %finished = icmp eq i32 %y, 0
  br i1 %finished, label %done, label %step

step:
  %remainder = srem i32 %x, %y
  br label %check

done:
  ret i32 %x
}

define i32 @square(i32 %x) {
entry:
  %product = mul i32 %x, %x
  ret i32 %product
}
