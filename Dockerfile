FROM node:9.2.0-wheezy

RUN apt-get update && apt-get install -y libc6-dev

# Create app directory
RUN mkdir -p /usr/share/resource-srv
RUN mkdir -p /root/.ssh
WORKDIR /usr/share/resource-srv

# Set config volumes
VOLUME /usr/share/resource-srv/cfg
VOLUME /usr/share/resource-srv/protos

# Bundle app source
COPY . /usr/share/resource-srv

# Install app dependencies
RUN npm install -g typescript

RUN cd /usr/share/resource-srv
COPY id_rsa /root/.ssh/
COPY config /root/.ssh/
COPY known_hosts /root/.ssh/

RUN npm install
RUN npm run postinstall

EXPOSE 50051
CMD [ "node", "service.js" ]

# To build the image:
# docker build -t restorecommerce/resource-srv .
#
# To create a container:
# docker create --name resource-srv -v <absolute_path_to_cfg>/:/usr/share/resource-srv/cfg --net restorecommercedev_default restorecommerce/resource
#
# docker create --name resource-srv --net restorecms_default restorecommerce/resource-srv
#
# To run the container:
# docker start resource-srv
