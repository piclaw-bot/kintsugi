#include <sys/socket.h>
#include <netinet/in.h>
#include <unistd.h>
#include <stdlib.h>
#include <string.h>
int main(int argc,char **argv){int fd=socket(AF_INET,SOCK_STREAM,0);struct sockaddr_in a={.sin_family=AF_INET,.sin_port=htons(8080),.sin_addr.s_addr=htonl(argc>1?0x7f000001:0)};if(argc>1){if(connect(fd,(void*)&a,sizeof(a)))return 2;char *r="GET /burn HTTP/1.0\r\n\r\n";write(fd,r,strlen(r));char b[16];read(fd,b,sizeof b);return 0;}int yes=1;setsockopt(fd,SOL_SOCKET,SO_REUSEADDR,&yes,sizeof yes);if(bind(fd,(void*)&a,sizeof(a)))return 3;listen(fd,4);for(;;){int c=accept(fd,0,0);char b[128]={0};read(c,b,127);if(strstr(b,"/burn")){for(;;){volatile char *p=malloc(8<<20);if(!p)return 4;for(int i=0;i<(8<<20);i+=4096)p[i]=1;usleep(5000);}}else{char *r="HTTP/1.0 200 OK\r\n\r\nok";write(c,r,strlen(r));close(c);}}}
