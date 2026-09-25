#include "features/movement/udodge/UDodgeCaptureWire.h"
#include <iostream>
int main(){UDodgeCapture::Scene s;s.enemyCount=s.enemiesObserved=1;s.projectileCount=s.projectilesObserved=1;s.projectiles[0].count=1;s.projectiles[0].totalPoints=1;s.candidateCount=s.candidatesObserved=1;std::cout<<UDodgeCapture::Encode(s,1,2,3,4);}
